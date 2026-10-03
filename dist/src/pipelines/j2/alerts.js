/**
 * Idempotent deferred-queue alerts. One email per threshold (80%, 100%) per calendar month in
 * Julian's timezone. The message body depends only on the key's inputs (level, bound), never on
 * the live count, so repeated calls reuse an identical payload and the delivery ledger dedupes them.
 */
import { zonedParts } from "../../jobs/time.js";
import { deliverOnce } from "../../notify/delivery.js";
export class DeferredQueueAlerts {
    store;
    sender;
    timezone;
    now;
    constructor(store, sender, timezone, now = () => new Date()) {
        this.store = store;
        this.sender = sender;
        this.timezone = timezone;
        this.now = now;
    }
    async deferredQueue(level, _count, max) {
        const p = zonedParts(this.now(), this.timezone);
        const month = `${p.year}-${String(p.month).padStart(2, "0")}`;
        const key = `deferred-queue-alert:${level}:${month}`;
        const threshold = level === 100 ? max : Math.ceil(max * 0.8);
        await deliverOnce(this.store, this.sender, key, "deferred_queue_alert", {
            subject: level === 100 ? "Finagai: deferred-capture queue is full" : "Finagai: deferred-capture queue at 80%",
            text: level === 100
                ? `The model-spend ceiling is reached and ${threshold} of ${max} deferred captures are queued. New captures are now refused until budget is available or you raise the ceiling.`
                : `The model-spend ceiling is reached and the deferred-capture queue has reached ${threshold} of ${max}. Captures are stored safely and will be processed when budget is available.`,
        });
    }
}
//# sourceMappingURL=alerts.js.map