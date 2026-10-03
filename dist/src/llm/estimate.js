/**
 * Worst-case cost of a model call, computed before the call (ADR-034).
 *
 * Input tokens are bounded by UTF-8 bytes: every BPE token covers at least one byte, so
 * tokens <= bytes. A fixed allowance per message covers role and formatting overhead. Input is
 * priced at the cache-write rate (the most expensive way input can be billed). Output is bounded
 * by max_tokens. The real cost is therefore never above this estimate, provided MODEL_PRICES
 * matches Anthropic's published prices.
 */
import { MODEL_PRICES, WEB_SEARCH_USD_PER_REQUEST } from "./pricing.js";
export const MESSAGE_OVERHEAD_TOKENS = 64;
/** Hard ceiling on any single call; requests that could exceed it are refused (G20). */
export const PER_CALL_MAX_USD = 1.0;
/** A screenshot bills around 1,500 tokens; count it generously so the budget bound stays conservative. */
export const IMAGE_TOKENS_BYTES_EQUIV = 1_600 * 4;
export function maxInputTokens(req) {
    const bytes = Buffer.byteLength(req.system, "utf8") +
        req.messages.reduce((n, m) => n + (typeof m.content === "string"
            ? Buffer.byteLength(m.content, "utf8")
            : m.content.reduce((k, b) => k + (b.type === "text" ? Buffer.byteLength(b.text, "utf8") : IMAGE_TOKENS_BYTES_EQUIV), 0)), 0);
    return bytes + MESSAGE_OVERHEAD_TOKENS * (req.messages.length + 1);
}
/**
 * Web search (J5): results are injected as input and the conversation is re-read on every search
 * iteration, so each allowed search reserves a generous token allowance plus its per-request fee.
 * Unlike plain calls this bound is an allowance, not a proof (ADR-044); max_uses keeps it small.
 */
export const WEB_SEARCH_TOKEN_ALLOWANCE = 40_000;
export function worstCaseCostUsd(req) {
    const p = MODEL_PRICES[req.model];
    if (!p)
        throw new Error(`no price configured for model ${req.model}`);
    const inputRate = (p.inputPerMTok / 1_000_000) * Math.max(1, p.cacheWriteMultiplier);
    const searches = req.webSearch?.maxUses ?? 0;
    // Each search iteration re-reads the prompt and everything found so far.
    const searchInput = searches * (maxInputTokens(req) + WEB_SEARCH_TOKEN_ALLOWANCE * (searches + 1) / 2);
    const thinking = (("thinkingTokens" in req ? req.thinkingTokens : 0) ?? 0);
    const cost = (maxInputTokens(req) + searchInput) * inputRate + (req.maxTokens + thinking) * (p.outputPerMTok / 1_000_000)
        + searches * WEB_SEARCH_USD_PER_REQUEST;
    return Math.ceil(cost * 1_000_000) / 1_000_000;
}
//# sourceMappingURL=estimate.js.map