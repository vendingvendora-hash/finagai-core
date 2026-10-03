/**
 * Resend email sender. The recipient, sender, and reply-to come from configuration only (G18).
 * The idempotency key is forwarded unchanged on every retry; Resend's retention of keys is
 * limited, so the local ledger (deliverOnce) remains authoritative.
 */
import { AmbiguousSendError, PROVIDER_TIMEOUT_MS, ProviderIdempotencyConflictError } from "./delivery.js";
export class TransientSendError extends Error {
}
export class ResendSender {
    cfg;
    fetchFn;
    timeoutMs;
    constructor(cfg, fetchFn = fetch, timeoutMs = PROVIDER_TIMEOUT_MS) {
        this.cfg = cfg;
        this.fetchFn = fetchFn;
        this.timeoutMs = timeoutMs;
    }
    async send(m, idempotencyKey) {
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
        }
        catch {
            // Includes timeouts. The outcome is ambiguous: the provider may have accepted the message.
            // A retry reuses the same idempotency key, which covers that case while the key is retained.
            throw new AmbiguousSendError("email provider did not respond in time; delivery outcome unknown");
        }
        const body = (await res.json().catch(() => ({})));
        if (res.status >= 200 && res.status < 300)
            return body.id ?? null;
        if (res.status === 409 && body.name === "invalid_idempotent_request") {
            throw new ProviderIdempotencyConflictError("provider rejected reuse of key with a different payload");
        }
        // 5xx and a concurrent-request 409 leave the outcome unknown; 429 means not accepted.
        if (res.status >= 500 || res.status === 409) {
            throw new AmbiguousSendError(`email provider outcome unknown (HTTP ${res.status})`);
        }
        if (res.status === 429)
            throw new TransientSendError("email provider rate-limited the request; not accepted");
        throw new Error(`email provider rejected the message (HTTP ${res.status})`);
    }
}
//# sourceMappingURL=resend.js.map