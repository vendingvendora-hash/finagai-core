/**
 * Real-model evaluation runner for J2 cases (eval/cases/*.yaml with status: ready).
 *
 *   EVAL_DATABASE_URL   finagai_app connection to an evaluation database (scripts/eval-j2.sh provides a local one)
 *   ANTHROPIC_API_KEY   key from the "finagai" workspace (never the production runtime key in CI logs)
 *
 * Each case runs `repetitions` times, each in its own project, so runs never interfere and nothing
 * needs deleting. Model calls use the "eval" purpose: they pause at the $30 target and the report
 * states the cost instead of silently reducing the evaluation (ADR-025). Pass bar (A1): zero
 * unacceptable-class failures across every repetition.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../../src/config/index.js";
import { createPool, PgLlmCallRecorder } from "../../src/db/index.js";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import { MeteredModelClient } from "../../src/llm/metered.js";
import { runCapture, type CaptureSummary } from "../../src/pipelines/j2/capture.js";
import { verdicts } from "./verdict.js";

interface Assertion { name: string; class: "unacceptable" | "costly" | "cheap"; sql: string; expect: unknown; required?: boolean }
interface Case { id: string; job: string; title: string; repetitions: number; status: string; received_at?: string; prior: string[]; input: string; assertions: Assertion[] }

/** Declares $1-$3 as UUIDs for every assertion, so a case may use any subset of them. */
export function wrapAssertion(sql: string): string {
  return `SELECT (${sql}) AS v FROM (SELECT $1::uuid AS c, $2::uuid AS p, $3::uuid AS r) AS _params`;
}

async function main() {
  const dbUrl = process.env.EVAL_DATABASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!dbUrl || !apiKey) throw new Error("EVAL_DATABASE_URL and ANTHROPIC_API_KEY are required");
  const cfg = loadConfig({ ...process.env, NODE_ENV: "test" });
  const pool = createPool(dbUrl);
  const recorder = new PgLlmCallRecorder(pool, cfg.FINAGAI_TIMEZONE);
  const model = new MeteredModelClient(new AnthropicProvider(apiKey), recorder,
    { limits: { targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH } });
  const dir = join(process.cwd(), "eval", "cases");
  const only = process.argv[2];
  const cases = readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => parse(readFileSync(join(dir, f), "utf8")) as Case)
    .filter((c) => c.job === "J2" && c.status === "ready" && (!only || c.id === only));
  const spendBefore = await recorder.monthToDateUsd(new Date());
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results: Array<{ case: string; rep: number; status: string; failures: Array<{ name: string; class: string; got: unknown; expect: unknown }> }> = [];

  for (const c of cases) {
    for (let rep = 1; rep <= c.repetitions; rep++) {
      const projectName = `Eval ${c.id} ${runId} r${rep}`;
      const projectId = (await pool.query<{ id: string }>(`INSERT INTO project (name) VALUES ($1) RETURNING id`, [projectName])).rows[0]!.id;
      const received = c.received_at ? new Date(c.received_at) : new Date();
      const deps = { pool, model, cfg, now: () => received };
      const run = (text: string, n: string): Promise<CaptureSummary> => runCapture(deps, {
        text, sourceType: "conversation", mode: "eval", client: "eval", idempotencyKey: `eval:${runId}:${c.id}:${rep}:${n}`, projectHint: projectName });
      const priors: string[] = [];
      let status = "ok";
      try {
        for (const [i, t] of c.prior.entries()) priors.push((await run(t, `prior${i}`)).captureId);
        const s = await run(c.input, "input");
        status = s.status;
        const failures = [];
        for (const a of c.assertions) {
          const got = (await pool.query(wrapAssertion(a.sql), [s.captureId, projectId, priors[0] ?? null])).rows[0];
          const value = got ? got.v : null;
          if (value !== a.expect) failures.push({ name: a.name, class: a.class, got: value, expect: a.expect });
        }
        results.push({ case: c.id, rep, status, failures });
      } catch (err) {
        results.push({ case: c.id, rep, status: "error", failures: [{ name: err instanceof Error ? err.message : "error", class: "costly", got: null, expect: null }] });
      }
    }
  }
  const spendAfter = await recorder.monthToDateUsd(new Date());
  // Severity and pass/fail are separate (ADR-038). A baseline case passes only if EVERY required
  // assertion passes in EVERY repetition with no execution error. Nothing is averaged away.
  const unacceptable = results.flatMap((r) => r.failures.filter((f) => f.class === "unacceptable").map((f) => ({ case: r.case, rep: r.rep, ...f })));
  const { safetyPassed, acceptancePassed, caseVerdicts, executionErrors } = verdicts(cases, results);
  const errors = { length: executionErrors };
  const report = {
    runId, models: { extract: cfg.MODEL_J2_EXTRACT, classify: cfg.MODEL_J2_CLASSIFY },
    passBar: "acceptancePassed: every required assertion passes in every repetition, with no execution errors",
    safetyPassed, acceptancePassed,
    cases: caseVerdicts,
    unacceptableFailures: unacceptable,
    costlyFailures: results.flatMap((r) => r.failures.filter((f) => f.class === "costly").map((f) => ({ case: r.case, rep: r.rep, ...f }))),
    cheapFailures: results.flatMap((r) => r.failures.filter((f) => f.class === "cheap").map((f) => ({ case: r.case, rep: r.rep, ...f }))),
    executionErrors,
    evalCostUsd: Number((spendAfter - spendBefore).toFixed(6)),
    results,
  };
  mkdirSync(join(process.cwd(), "eval", "reports"), { recursive: true });
  writeFileSync(join(process.cwd(), "eval", "reports", `j2-${runId}.json`), JSON.stringify(report, null, 2));
  process.stdout.write(`J2 evaluation: acceptance ${acceptancePassed ? "PASSED" : "FAILED"}, safety ${safetyPassed ? "PASSED" : "FAILED"}; ` +
    `${caseVerdicts.filter((v) => v.passed).length}/${caseVerdicts.length} cases passed; ${unacceptable.length} unacceptable, ` +
    `${report.costlyFailures.length} costly, ${report.cheapFailures.length} cheap failures; ${errors.length} errors; cost $${report.evalCostUsd}\n`);
  await pool.end();
  process.exit(acceptancePassed ? 0 : 1); // the pre-pilot baseline gate is acceptance, not safety alone
}

main().catch((err) => { process.stderr.write(`evaluation runner failed: ${err instanceof Error ? err.message : "error"}\n`); process.exit(2); });
