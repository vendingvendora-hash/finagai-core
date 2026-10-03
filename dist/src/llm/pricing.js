export const MODEL_PRICES = {
    "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
    "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
    "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
    "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
};
export function costUsd(model, u) {
    const p = MODEL_PRICES[model];
    if (!p)
        throw new Error(`no price configured for model ${model}`);
    const perToken = p.inputPerMTok / 1_000_000;
    const cost = u.inputTokens * perToken +
        u.cacheReadTokens * perToken * p.cacheReadMultiplier +
        u.cacheWriteTokens * perToken * p.cacheWriteMultiplier +
        u.outputTokens * (p.outputPerMTok / 1_000_000);
    return Math.round(cost * 1_000_000) / 1_000_000; // matches numeric(12,6)
}
/** Anthropic web search: $10 per 1,000 searches, on top of tokens. */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;
export function webSearchCostUsd(requests) {
    return Math.round((requests ?? 0) * WEB_SEARCH_USD_PER_REQUEST * 1_000_000) / 1_000_000;
}
//# sourceMappingURL=pricing.js.map