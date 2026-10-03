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
import { decideBudget } from "../guards/budget.js";
import { worstCaseCostUsd, PER_CALL_MAX_USD } from "./estimate.js";
import { costUsd, webSearchCostUsd } from "./pricing.js";
import { withRetries } from "./retry.js";
import { BudgetBlockedError } from "./types.js";
/** The policy applied inside reserve(): the projected total includes this call's worst case. */
export function decideReservation(committedPlusReservedUsd, reservedUsd, limits, purpose) {
    return decideBudget(committedPlusReservedUsd + reservedUsd, limits, purpose);
}
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
export class MeteredModelClient {
    provider;
    recorder;
    opts;
    constructor(provider, recorder, opts) {
        this.provider = provider;
        this.recorder = recorder;
        this.opts = opts;
    }
    async complete(req) {
        const reservedUsd = worstCaseCostUsd(req); // throws for an unpriced model, before anything is recorded
        if (reservedUsd > PER_CALL_MAX_USD) {
            throw new BudgetBlockedError(`request exceeds the per-call ceiling (worst case $${reservedUsd.toFixed(4)})`, "per_call");
        }
        const identity = {
            pipeline: req.pipeline, step: req.step, model: req.model, promptVersion: req.promptVersion, purpose: req.purpose,
            ...(req.captureId ? { captureId: req.captureId } : {}),
            ...(req.reviewId ? { reviewId: req.reviewId } : {}),
            ...(req.requestId ? { requestId: req.requestId } : {}),
        };
        const now = (this.opts.now ?? (() => new Date()))();
        const reservation = await this.recorder.reserve({ ...identity, reservedUsd, limits: this.opts.limits, now });
        if (!reservation.allowed)
            throw new BudgetBlockedError(reservation.decision.reason ?? "budget blocked", reservation.decision.level);
        const started = Date.now();
        try {
            const { value, retries } = await withRetries(() => this.provider.send(req), {
                maxRetries: this.opts.maxRetries ?? 3,
                baseDelayMs: this.opts.baseDelayMs ?? 1000,
                ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
            });
            const latencyMs = Date.now() - started;
            const cost = Math.round((costUsd(req.model, value.usage) + webSearchCostUsd(value.webSearchRequests)) * 1_000_000) / 1_000_000;
            await this.recorder.settle(reservation.reservationId, { status: "ok", usage: value.usage, costUsd: cost, latencyMs, retries });
            return { ...value, costUsd: cost, retries, latencyMs };
        }
        catch (err) {
            const retries = err.retries ?? 0;
            await this.recorder.settle(reservation.reservationId, { status: "error", usage: ZERO, costUsd: 0, latencyMs: Date.now() - started, retries });
            throw err;
        }
    }
}
//# sourceMappingURL=metered.js.map