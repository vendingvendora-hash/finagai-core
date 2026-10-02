/**
 * Worst-case cost of a model call, computed before the call (ADR-034).
 *
 * Input tokens are bounded by UTF-8 bytes: every BPE token covers at least one byte, so
 * tokens <= bytes. A fixed allowance per message covers role and formatting overhead. Input is
 * priced at the cache-write rate (the most expensive way input can be billed). Output is bounded
 * by max_tokens. The real cost is therefore never above this estimate, provided MODEL_PRICES
 * matches Anthropic's published prices.
 */
import { MODEL_PRICES } from "./pricing.js";
import type { ModelRequest } from "./types.js";

export const MESSAGE_OVERHEAD_TOKENS = 64;
/** Hard ceiling on any single call; requests that could exceed it are refused (G20). */
export const PER_CALL_MAX_USD = 1.0;

export function maxInputTokens(req: Pick<ModelRequest, "system" | "messages">): number {
  const bytes = Buffer.byteLength(req.system, "utf8") +
    req.messages.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0);
  return bytes + MESSAGE_OVERHEAD_TOKENS * (req.messages.length + 1);
}

export function worstCaseCostUsd(req: Pick<ModelRequest, "model" | "system" | "messages" | "maxTokens">): number {
  const p = MODEL_PRICES[req.model];
  if (!p) throw new Error(`no price configured for model ${req.model}`);
  const inputRate = (p.inputPerMTok / 1_000_000) * Math.max(1, p.cacheWriteMultiplier);
  const cost = maxInputTokens(req) * inputRate + req.maxTokens * (p.outputPerMTok / 1_000_000);
  return Math.ceil(cost * 1_000_000) / 1_000_000;
}
