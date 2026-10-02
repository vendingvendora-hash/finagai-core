/**
 * Entry point for the Render cron service "finagai-scheduler" (every 15 minutes, ADR-027).
 * Exits non-zero only if dispatch itself fails, so Render marks the run failed and notifies.
 */
import { loadConfig } from "../config/index.js";
import { createPool, PgDeliveryStore, PgJobLedger, PgLlmCallRecorder } from "../db/index.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { MeteredModelClient } from "../llm/metered.js";
import { ResendSender } from "../notify/resend.js";
import { missedRunCheckHandler, weeklyReviewHandler } from "./j3Handlers.js";
import { dailyMaintenanceHandler } from "./maintenance.js";
import type pg from "pg";
import { createLogger } from "../server/log.js";
import { dispatch, MAX_JOB_ATTEMPTS, slotIdempotencyKey } from "./dispatcher.js";
import { deliverOnce } from "../notify/delivery.js";
import { placeholderHandlers } from "./handlers.js";

async function main() {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg);
  let pool: pg.Pool | undefined;
  // Handlers are built lazily, only when a job is due, so quiet ticks never touch the database.
  const lazyPool = () => (pool ??= createPool(cfg.DATABASE_URL, 2));
  const j3Deps = () => {
    const p = lazyPool();
    const recorder = new PgLlmCallRecorder(p, cfg.FINAGAI_TIMEZONE);
    const model = new MeteredModelClient(new AnthropicProvider(cfg.ANTHROPIC_API_KEY), recorder,
      { limits: { targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH } });
    return {
      pool: p, store: new PgDeliveryStore(p), timezone: cfg.FINAGAI_TIMEZONE, weeklyReviewTime: cfg.WEEKLY_REVIEW_TIME,
      sender: new ResendSender({ apiKey: cfg.RESEND_API_KEY, from: cfg.NOTIFY_FROM, to: cfg.NOTIFY_TO, replyTo: cfg.NOTIFY_REPLY_TO }),
      j3: { pool: p, model, modelId: cfg.MODEL_J3_COMPOSE,
        collect: { timezone: cfg.FINAGAI_TIMEZONE, stallThresholdDays: cfg.STALL_THRESHOLD_DAYS,
          upcomingWindowDays: cfg.UPCOMING_WINDOW_DAYS, priorityUpcomingWindowDays: cfg.PRIORITY_UPCOMING_WINDOW_DAYS },
        budget: async () => ({ monthToDateUsd: await recorder.monthToDateUsd(new Date()),
          targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH }) },
    };
  };
  try {
    const result = await dispatch(new Date(), {
      cfg,
      handlers: {
        ...placeholderHandlers(),
        weekly_review: (ctx) => weeklyReviewHandler(j3Deps())(ctx),
        missed_run_check: (ctx) => missedRunCheckHandler(j3Deps())(ctx),
        daily_maintenance: (ctx) => {
          const d = j3Deps();
          return dailyMaintenanceHandler(d.pool, () => ({ pool: d.pool, model: d.j3.model, cfg }))(ctx);
        },
      },
      log,
      openLedger: async () => new PgJobLedger(lazyPool()),
    });
    log("scheduler tick", { due: result.due, ran: result.ran.length, notClaimed: result.notClaimed });
    // A job that failed its final attempt alerts Julian once per slot (detection beside recovery).
    for (const r of result.ran.filter((x) => x.outcome.status === "failed" && x.attempt >= MAX_JOB_ATTEMPTS)) {
      const d = j3Deps();
      await deliverOnce(d.store, d.sender, `job-failed:${slotIdempotencyKey(r.job, r.scheduledFor)}`, "job_failure_alert", {
        subject: `Finagai: scheduled job failed (${r.job})`,
        text: `The ${r.job} job for ${r.scheduledFor.toISOString()} failed after ${r.attempt} attempts. Check job_run and the service logs.`,
      }).catch((e) => log("job failure alert not sent", { error: e instanceof Error ? e.name : "error" }));
    }
  } finally {
    await pool?.end();
  }
}

main().catch((err) => {
  process.stderr.write(`scheduler failed: ${err instanceof Error ? err.name : "error"}\n`);
  process.exit(1);
});
