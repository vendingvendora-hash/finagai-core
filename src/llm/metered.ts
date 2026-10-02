/**
 * The client every pipeline uses (G20, ADR-034).
 *
 * Before each call it atomically RESERVES the call's worst-case cost: under a single database
 * lock it adds committed spend + live reservations + this call's worst case, applies the cap
 * policy to that projected total, and either records a reservation or a budget_blocked row.
 * After the call it settles the reservation to the actual cost. Concurrent calls therefore
 * cannot both pass on the same stale total, and no call can start whose worst case would
 * cross its purpose's threshold.
 */
import { decideBudget, type BudgetDecision, type BudgetLimits, type CallPurpose } from "../guards/budget.js";
import { worstCaseCostUsd, PER_CALL_MAX_USD } from "./estimate.js";
import { costUsd, type TokenUsage } from "./pricing.js";
import { withRetries } from "./retry.js";
import { BudgetBlockedError, type ModelProvider, type ModelRequest, type ModelResult } from "./types.js";

export interface CallIdentity {
  pipeline: ModelRequest["pipeline"];
  step: string;
  model: string;
  promptVersion: string;
  purpose: CallPurpose;
  captureId?: string;
  reviewId?: string;
  requestId?: string;
}

export interface ReservationRequest extends CallIdentity {
  reservedUsd: number;
  limits: BudgetLimits;
  now: Date;
}

export type ReservationResult =
  | { allowed: true; reservationId: string; decision: BudgetDecision }
  | { allowed: false; decision: BudgetDecision };

export interface Settlement {
  status: "ok" | "error";
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  retries: number;
}

export interface LlmCallRecorder {
  /** Atomic: check projected spend and either reserve or record a budget_blocked row. */
  reserve(r: ReservationRequest): Promise<ReservationResult>;
  settle(reservationId: string, s: Settlement): Promise<void>;
  /** Committed spend plus live reservations, for the month containing `now` in Julian's timezone. */
  monthToDateUsd(now: Date): Promise<number>;
}

/** The policy applied inside reserve(): the projected total includes this call's worst case. */
export function decideReservation(committedPlusReservedUsd: number, reservedUsd: number, limits: BudgetLimits, purpose: CallPurpose) {
  return decideBudget(committedPlusReservedUsd + reservedUsd, limits, purpose);
}

export interface MeteredClientOptions {
  limits: BudgetLimits;
  maxRetries?: number;
  baseDelayMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export class MeteredModelClient {
  constructor(
    private readonly provider: ModelProvider,
    private readonly recorder: LlmCallRecorder,
    private readonly opts: MeteredClientOptions,
  ) {}

  async complete(req: ModelRequest): Promise<ModelResult> {
    const reservedUsd = worstCaseCostUsd(req); // throws for an unpriced model, before anything is recorded
    if (reservedUsd > PER_CALL_MAX_USD) {
      throw new BudgetBlockedError(`request exceeds the per-call ceiling (worst case $${reservedUsd.toFixed(4)})`, "per_call");
    }
    const identity: CallIdentity = {
      pipeline: req.pipeline, step: req.step, model: req.model, promptVersion: req.promptVersion, purpose: req.purpose,
      ...(req.captureId ? { captureId: req.captureId } : {}),
      ...(req.reviewId ? { reviewId: req.reviewId } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
    };
    const now = (this.opts.now ?? (() => new Date()))();
    const reservation = await this.recorder.reserve({ ...identity, reservedUsd, limits: this.opts.limits, now });
    if (!reservation.allowed) throw new BudgetBlockedError(reservation.decision.reason ?? "budget blocked", reservation.decision.level);

    const started = Date.now();
    try {
      const { value, retries } = await withRetries(() => this.provider.send(req), {
        maxRetries: this.opts.maxRetries ?? 3,
        baseDelayMs: this.opts.baseDelayMs ?? 1000,
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      });
      const latencyMs = Date.now() - started;
      const cost = costUsd(req.model, value.usage);
      await this.recorder.settle(reservation.reservationId, { status: "ok", usage: value.usage, costUsd: cost, latencyMs, retries });
      return { ...value, costUsd: cost, retries, latencyMs };
    } catch (err) {
      const retries = (err as { retries?: number }).retries ?? 0;
      await this.recorder.settle(reservation.reservationId, { status: "error", usage: ZERO, costUsd: 0, latencyMs: Date.now() - started, retries });
      throw err;
    }
  }
}
