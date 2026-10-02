/**
 * Idempotent deferred-queue alerts. One email per threshold (80%, 100%) per calendar month in
 * Julian's timezone. The message body depends only on the key's inputs (level, bound), never on
 * the live count, so repeated calls reuse an identical payload and the delivery ledger dedupes them.
 */
import { zonedParts } from "../../jobs/time.js";
import { deliverOnce, type DeliveryStore, type EmailSender } from "../../notify/delivery.js";
import type { J2Alerts } from "./capture.js";

export class DeferredQueueAlerts implements J2Alerts {
  constructor(private readonly store: DeliveryStore, private readonly sender: EmailSender,
    private readonly timezone: string, private readonly now: () => Date = () => new Date()) {}

  async deferredQueue(level: 80 | 100, _count: number, max: number): Promise<void> {
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
