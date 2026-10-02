/**
 * Resend email sender. The recipient, sender, and reply-to come from configuration only (G18).
 * The idempotency key is forwarded unchanged on every retry; Resend's retention of keys is
 * limited, so the local ledger (deliverOnce) remains authoritative.
 */
import { AmbiguousSendError, PROVIDER_TIMEOUT_MS, ProviderIdempotencyConflictError, type EmailMessage, type EmailSender } from "./delivery.js";

export interface ResendConfig {
  apiKey: string;
  /** Defaults to Resend's API; overridable only for local simulation. */
  endpoint?: string;
  from: string;
  to: string;
  replyTo: string;
}

export class TransientSendError extends Error {}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export class ResendSender implements EmailSender {
  constructor(private readonly cfg: ResendConfig, private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS) {}

  async send(m: EmailMessage, idempotencyKey: string): Promise<string | null> {
    let res;
    try {
      res = await this.fetchFn(this.cfg.endpoint ?? "https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: this.cfg.from, to: [this.cfg.to], reply_to: this.cfg.replyTo,
        subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}),
      }),
      });
    } catch {
      // Includes timeouts. The outcome is ambiguous: the provider may have accepted the message.
      // A retry reuses the same idempotency key, which covers that case while the key is retained.
      throw new AmbiguousSendError("email provider did not respond in time; delivery outcome unknown");
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string };
    if (res.status >= 200 && res.status < 300) return body.id ?? null;
    if (res.status === 409 && body.name === "invalid_idempotent_request") {
      throw new ProviderIdempotencyConflictError("provider rejected reuse of key with a different payload");
    }
    // 5xx and a concurrent-request 409 leave the outcome unknown; 429 means not accepted.
    if (res.status >= 500 || res.status === 409) {
      throw new AmbiguousSendError(`email provider outcome unknown (HTTP ${res.status})`);
    }
    if (res.status === 429) throw new TransientSendError("email provider rate-limited the request; not accepted");
    throw new Error(`email provider rejected the message (HTTP ${res.status})`);
  }
}
