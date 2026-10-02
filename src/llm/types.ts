import type { CallPurpose } from "../guards/budget.js";
import type { TokenUsage } from "./pricing.js";

export type Pipeline = "j2" | "j3" | "seed" | "eval_grader" | "j5";

export interface ModelRequest {
  pipeline: Pipeline;
  step: string;
  purpose: CallPurpose;
  model: string;
  promptVersion: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  /** Anthropic's server-side web search (J5 only). Each search is billed per request plus result tokens. */
  webSearch?: { maxUses: number };
  captureId?: string;
  reviewId?: string;
  requestId?: string;
}

export interface ProviderResult {
  text: string;
  model: string;
  stopReason: string | null;
  usage: TokenUsage;
  /** Server-side web searches performed during the call (billed per search). */
  webSearchRequests?: number;
}

export interface ModelResult extends ProviderResult {
  costUsd: number;
  retries: number;
  latencyMs: number;
}

/** The only interface pipelines depend on; the Anthropic SDK stays behind it. */
export interface ModelProvider {
  send(req: ModelRequest): Promise<ProviderResult>;
}

/** Retryable: rate limits, overload, and server errors. */
export class TransientModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Not retryable: bad request, authentication, permission, invalid model. */
export class PermanentModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class BudgetBlockedError extends Error {
  constructor(message: string, readonly level: "restricted" | "ceiling" | "warning" | "normal" | "per_call") {
    super(message);
  }
}
