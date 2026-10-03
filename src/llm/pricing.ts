/**
 * Model prices in USD per million tokens. Values from the architecture research (2026-10-01);
 * verify against Anthropic's pricing page before the Capable promotion decision.
 * An unknown model throws, so a misconfigured model can never bypass the spend cap.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadMultiplier: number;  // relative to input
  cacheWriteMultiplier: number; // relative to input (5-minute cache)
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costUsd(model: string, u: TokenUsage): number {
  const p = MODEL_PRICES[model];
  if (!p) throw new Error(`no price configured for model ${model}`);
  const perToken = p.inputPerMTok / 1_000_000;
  const cost =
    u.inputTokens * perToken +
    u.cacheReadTokens * perToken * p.cacheReadMultiplier +
    u.cacheWriteTokens * perToken * p.cacheWriteMultiplier +
    u.outputTokens * (p.outputPerMTok / 1_000_000);
  return Math.round(cost * 1_000_000) / 1_000_000; // matches numeric(12,6)
}

/** Anthropic web search: $10 per 1,000 searches, on top of tokens. */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

export function webSearchCostUsd(requests: number | undefined): number {
  return Math.round((requests ?? 0) * WEB_SEARCH_USD_PER_REQUEST * 1_000_000) / 1_000_000;
}
