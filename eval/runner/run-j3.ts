/**
 * Real-model J3 evaluation (T11-T20). Each case and repetition runs in its own fresh database on a
 * local disposable Postgres (scripts/eval-j3.sh), with the real compose model.
 *
 *   ANTHROPIC_API_KEY                                   evaluation key (finagai workspace)
 *   EVAL_PG_ADMIN_URL / EVAL_PG_MIGRATOR_TEMPLATE / EVAL_PG_APP_TEMPLATE   set by scripts/eval-j3.sh
 *   EVAL_MAX_SPEND_USD (default 5)                      hard cap for this run; remaining cases are reported
 *                                                       as not run with the expected incremental cost
 *
 * Verdicts (ADR-038): acceptancePassed requires every REQUIRED assertion in every repetition and no
 * errors; rubric criteria are graded and reported but not required until Julian sets a threshold.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { createPool, PgLlmCallRecorder } from "../../src/db/index.js";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import { MeteredModelClient } from "../../src/llm/metered.js";
import { runReview } from "../../src/pipelines/j3/review.js";
import { evaluate, J3_NOW, loadJ3Cases, materialize, withImplicit } from "./j3cases.js";
import { verdicts, type RunResult } from "./verdict.js";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const adminUrl = process.env.EVAL_PG_ADMIN_URL, migratorTemplate = process.env.EVAL_PG_MIGRATOR_TEMPLATE, appTemplate = process.env.EVAL_PG_APP_TEMPLATE;
  if (!apiKey || !adminUrl || !migratorTemplate || !appTemplate) throw new Error("run through scripts/eval-j3.sh with ANTHROPIC_API_KEY set");
  const cfg = loadConfig({ ...process.env, NODE_ENV: "test" });
  const maxSpend = Number(process.env.EVAL_MAX_SPEND_USD ?? 5);
  const only = process.argv[2];
  const cases = loadJ3Cases().filter((c) => !only || c.id === only);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const provider = new AnthropicProvider(apiKey);
  const results: Array<RunResult & { rubric: Array<{ name: string; pass: boolean; reason: string }>; costUsd: number }> = [];
  const notRun: string[] = [];
  let spent = 0;

  for (const c of cases) {
    for (let rep = 1; rep <= c.repetitions; rep++) {
      if (spent >= maxSpend) { notRun.push(`${c.id} r${rep}`); continue; }
      const db = await materialize({ adminUrl, migratorTemplate, appTemplate, migrationsDir: join(process.cwd(), "migrations") },
        `eval_${c.id.toLowerCase()}_r${rep}_${Date.now()}`, c.fixtures);
      const pool = createPool(db.appUrl);
      const recorder = new PgLlmCallRecorder(pool, cfg.FINAGAI_TIMEZONE);
      const model = new MeteredModelClient(provider, recorder, { limits: { targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH } });
      try {
        const out = await runReview({ pool, model, modelId: cfg.MODEL_J3_COMPOSE, now: () => J3_NOW,
          collect: { timezone: cfg.FINAGAI_TIMEZONE, stallThresholdDays: cfg.STALL_THRESHOLD_DAYS, upcomingWindowDays: cfg.UPCOMING_WINDOW_DAYS,
            priorityUpcomingWindowDays: cfg.PRIORITY_UPCOMING_WINDOW_DAYS },
          budget: async () => ({ monthToDateUsd: 0, targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH }) },
          { kind: "on_demand", purpose: "eval" });
        const v = evaluate(c, out);
        const rubric = [];
        for (const r of v.rubric) {
          const g = await model.complete({ pipeline: "eval_grader", step: "rubric", purpose: "eval", model: cfg.MODEL_EVAL_GRADER, promptVersion: "j3-rubric-v0",
            maxTokens: 300, system: "You grade an operating review against one criterion. Return ONLY JSON: {\"pass\": boolean, \"reason\": string}.",
            messages: [{ role: "user", content: JSON.stringify({ criterion: r.criterion, review: out.rendered }) }] });
          let parsed = { pass: false, reason: "grader output unreadable" };
          try { parsed = JSON.parse(g.text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* recorded as fail */ }
          rubric.push({ name: r.name, pass: Boolean(parsed.pass), reason: String(parsed.reason).slice(0, 300) });
          if (!parsed.pass) v.failures.push({ name: r.name, class: r.class });
        }
        const costUsd = await recorder.monthToDateUsd(new Date());
        spent += costUsd;
        results.push({ case: c.id, rep, status: out.degraded ? "degraded" : "ok", failures: v.failures, rubric, costUsd });
      } catch (err) {
        results.push({ case: c.id, rep, status: "error", failures: [{ name: err instanceof Error ? err.message : "error", class: "costly" }], rubric: [], costUsd: 0 });
      } finally {
        await pool.end();
        await db.drop();
      }
    }
  }

  const specs = cases.map((c) => ({ id: c.id, assertions: withImplicit(c).map((a) => ({ name: a.name, class: a.class, ...(a.required === false ? { required: false } : {}) })) }));
  const v = verdicts(specs, results);
  const perRun = results.length ? spent / results.length : 0;
  const report = {
    runId, model: cfg.MODEL_J3_COMPOSE, grader: cfg.MODEL_EVAL_GRADER,
    safetyPassed: v.safetyPassed, acceptancePassed: v.acceptancePassed && notRun.length === 0,
    cases: v.caseVerdicts, notRunForBudget: notRun,
    expectedIncrementalCostUsd: Number((notRun.length * perRun).toFixed(4)),
    evalCostUsd: Number(spent.toFixed(6)), results,
  };
  mkdirSync(join(process.cwd(), "eval", "reports"), { recursive: true });
  writeFileSync(join(process.cwd(), "eval", "reports", `j3-${runId}.json`), JSON.stringify(report, null, 2));
  process.stdout.write(`J3 evaluation: acceptance ${report.acceptancePassed ? "PASSED" : "FAILED"}, safety ${report.safetyPassed ? "PASSED" : "FAILED"}; ` +
    `${v.caseVerdicts.filter((x) => x.passed).length}/${v.caseVerdicts.length} cases passed; ${notRun.length} runs not executed for budget ` +
    `(expected incremental cost $${report.expectedIncrementalCostUsd}); cost $${report.evalCostUsd}\n`);
  process.exit(report.acceptancePassed ? 0 : 1);
}

main().catch((err) => { process.stderr.write(`J3 evaluation runner failed: ${err instanceof Error ? err.message : "error"}\n`); process.exit(2); });
