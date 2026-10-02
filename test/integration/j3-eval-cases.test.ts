/**
 * Validates every ready J3 evaluation case WITHOUT spending API money: each case is materialized in its
 * own fresh database and reviewed by a FAITHFUL scripted composer. If a deterministic assertion fails
 * here, the case (fixture or assertion) is wrong, not the model. The real-model run uses run-j3.ts.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { runReview } from "../../src/pipelines/j3/review.js";
import type { ModelRequest, ModelResult } from "../../src/llm/types.js";
import { evaluate, J3_NOW, loadJ3Cases, materialize } from "../../eval/runner/j3cases.js";

const admin = process.env.INTEGRATION_ADMIN_URL;
const migratorTemplate = process.env.INTEGRATION_MIGRATOR_TEMPLATE;
const appTemplate = process.env.INTEGRATION_APP_TEMPLATE;

type Item = { id: string; section: string; must_mention: boolean; title: string; note: string | null };
const faithful = {
  async complete(req: ModelRequest): Promise<ModelResult> {
    const items = JSON.parse(req.messages[0]!.content) as Item[];
    const sections = new Map<string, object[]>();
    for (const i of items) {
      const l = sections.get(i.section) ?? [];
      l.push({ item_ids: [i.id], headline: i.title, why: null, urgency: i.must_mention ? "high" : "low", importance: i.must_mention ? "high" : "low", uncertainty: null });
      sections.set(i.section, l);
    }
    const act = items.find((i) => i.section === "requires_attention" && !(i.note ?? "").startsWith("disputed"));
    if (act) sections.set("recommended_actions", [{ item_ids: [act.id], headline: `Handle: ${act.title}`, why: null, urgency: "high", importance: "high", uncertainty: null }]);
    const body = { sections: [...sections].map(([section, entries]) => ({ section, entries })), nothing_material_changed: items.length === 0 };
    return { text: JSON.stringify(body), model: req.model, stopReason: "end_turn", costUsd: 0, retries: 0, latencyMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};

describe.skipIf(!admin || !migratorTemplate || !appTemplate)("J3 evaluation cases are valid (faithful composer, fresh DB per case)", () => {
  const cases = loadJ3Cases();
  it("finds the 10 ready J3 cases", () => expect(cases.map((c) => c.id)).toEqual(["T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20"]));
  for (const c of cases) {
    it(`${c.id}: every deterministic assertion passes`, async () => {
      const db = await materialize({ adminUrl: admin!, migratorTemplate: migratorTemplate!, appTemplate: appTemplate!, migrationsDir: join(process.cwd(), "migrations") },
        `evalcheck_${c.id.toLowerCase()}_${Date.now()}`, c.fixtures);
      const pool = createPool(db.appUrl);
      try {
        const r = await runReview({ pool, model: faithful, modelId: "claude-sonnet-5-5", now: () => J3_NOW,
          collect: { timezone: "America/New_York", stallThresholdDays: 14, upcomingWindowDays: 14, priorityUpcomingWindowDays: 30 },
          budget: async () => ({ monthToDateUsd: 0, targetUsd: 30, ceilingUsd: 36 }) }, { kind: "on_demand", purpose: "eval" });
        const v = evaluate(c, r);
        expect(v.failures).toEqual([]);
      } finally {
        await pool.end();
        await db.drop();
      }
    });
  }
});
