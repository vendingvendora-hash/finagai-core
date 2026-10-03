/**
 * Anthropic implementation of ModelProvider. SDK retries are disabled so that every retry is
 * counted and metered by Core; timeout is 60 seconds per call (implementation plan section 14).
 */
import Anthropic from "@anthropic-ai/sdk";
import { PermanentModelError, TransientModelError, type ModelProvider, type ModelRequest, type ProviderResult } from "./types.js";

const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function classifyStatus(status: number | undefined): "transient" | "permanent" {
  if (status === undefined) return "transient"; // network failure or timeout
  return TRANSIENT_STATUSES.has(status) ? "transient" : "permanent";
}

export class AnthropicProvider implements ModelProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string, timeoutMs = 60_000) {
    this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
  }

  async send(req: ModelRequest): Promise<ProviderResult> {
    try {
      const msg = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => (typeof m.content === "string" ? m : {
          role: m.role,
          content: m.content.map((b) => (b.type === "text"
            ? { type: "text", text: b.text }
            : { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.dataBase64 } })),
        })) as never,
        ...(req.webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: req.webSearch.maxUses }] as never } : {}),
      }, req.webSearch ? { timeout: 180_000 } : undefined);
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return {
        text,
        model: msg.model,
        stopReason: msg.stop_reason ?? null,
        webSearchRequests: (msg.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0,
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      // Messages carry no request content or credentials; the SDK's error text is not echoed.
      const message = `model call failed${status ? ` (HTTP ${status})` : ""}`;
      if (classifyStatus(status) === "transient") throw new TransientModelError(message, status);
      throw new PermanentModelError(message, status);
    }
  }
}
