/**
 * Phase 6 (ADR-085) — learners. Each reads Finagai's own records (never the model's opinion) and returns candidate
 * lessons with their evidence. Deterministic: the same records give the same lessons. Area-independent: outcome and
 * decision learners work on any opportunity kind / any Area; Career is just where the data is today.
 */
import type pg from "pg";
import { policyFor } from "./apply.js";
import type { Effect } from "./guard.js";

type Db = Pick<pg.Pool, "query">;
export interface Candidate {
  key: string; kind: "resource_performance" | "recovery" | "procedure" | "decision_pattern" | "outcome" | "correction";
  basis: "observed" | "inferred"; areaId?: string | null; scope: string; statement: string; effect?: Effect | null;
  support: number; positives?: number | null; confidence: number; evidence: Record<string, unknown>; lastEvidenceAt: string;
}

/** Wilson score lower bound (95%) — a rate we can trust given its sample size. */
export function wilsonLow(pos: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = pos / n; const d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : new Date(0).toISOString());
const VERIFIABLE = /^(browser_(fill|fill_form|select|check|click|upload|navigate|open_tab|switch_tab)|ax_click|ax_set_value|move_file|trash_file)$/;

/** How reliable each tool/step/workflow actually is (the planner and the brief use these; nothing is disabled). */
export async function resourcePerformance(db: Db, now: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const steps = (await db.query(`SELECT kind, count(*)::int AS n,
      count(*) FILTER (WHERE status = 'done' AND result ILIKE 'verified%')::int AS ok,
      max(ran_at) AS last, (array_agg(id::text ORDER BY ran_at DESC))[1:10] AS ids
    FROM control_step WHERE ran_at > $1::timestamptz - interval '60 days' AND status IN ('done','failed') GROUP BY kind`, [now])).rows;
  for (const s of steps) {
    if (!VERIFIABLE.test(s.kind) || s.n < 5) continue;
    const rate = s.ok / s.n;
    out.push({ key: `perf:j6.step:${s.kind}`, kind: "resource_performance", basis: "observed", scope: `j6.step:${s.kind}`, support: s.n, positives: s.ok, confidence: wilsonLow(s.ok, s.n),
      statement: `Mac step "${s.kind}" was verified ${s.ok}/${s.n} times in the last 60 days (${pct(s.ok, s.n)}).`, lastEvidenceAt: iso(s.last),
      evidence: { source: "control_step", window: "60 days", sampleIds: s.ids },
      effect: rate < 0.6 ? { type: "planner_hint", match: [s.kind], text: `"${s.kind}" was verified only ${s.ok}/${s.n} times recently: after it, re-read the page or window and check the expected change before moving on.` } : null });
  }
  const flows = (await db.query(`SELECT w->>'name' AS name, count(*)::int AS n, count(*) FILTER (WHERE (w->>'ok')::boolean)::int AS ok, max(t.started_at) AS last
    FROM event_tick t, jsonb_array_elements(COALESCE(t.stats->'workflows', '[]'::jsonb)) w WHERE t.started_at > $1::timestamptz - interval '30 days' GROUP BY 1`, [now])).rows;
  for (const f of flows) if (f.n >= 3) out.push({ key: `perf:workflow:${f.name}`, kind: "resource_performance", basis: "observed", scope: `workflow:${f.name}`, support: f.n, positives: f.ok,
    confidence: wilsonLow(f.ok, f.n), statement: `Workflow ${f.name} succeeded ${f.ok}/${f.n} runs in the last 30 days (${pct(f.ok, f.n)}).`, lastEvidenceAt: iso(f.last), evidence: { source: "event_tick.stats", window: "30 days" } });
  const tools = (await db.query(`SELECT reason AS tool, count(*)::int AS n, count(*) FILTER (WHERE after->>'outcome' = 'ok')::int AS ok, max(occurred_at) AS last
    FROM event WHERE action = 'tool_called' AND reason IS NOT NULL AND reason <> 'call_tool' AND occurred_at > $1::timestamptz - interval '30 days' GROUP BY reason`, [now])).rows;
  for (const t of tools) if (t.n >= 5) out.push({ key: `perf:tool:${t.tool}`, kind: "resource_performance", basis: "observed", scope: `tool:${t.tool}`, support: t.n, positives: t.ok,
    confidence: wilsonLow(t.ok, t.n), statement: `Tool ${t.tool} answered without error ${t.ok}/${t.n} times in the last 30 days (${pct(t.ok, t.n)}).`, lastEvidenceAt: iso(t.last), evidence: { source: "event(tool_called)", window: "30 days" } });
  return out;
}

/** After a step fails to verify, which next step actually worked (same task, within the next 3 steps)? */
export async function recoveries(db: Db, now: Date): Promise<Candidate[]> {
  const rows = (await db.query(`SELECT a.kind AS failed, b.kind AS fix, count(DISTINCT a.id)::int AS n, max(b.ran_at) AS last, (array_agg(DISTINCT t.code::text))[1:10] AS tasks
    FROM control_step a JOIN control_step b ON b.task_id = a.task_id AND b.seq > a.seq AND b.seq <= a.seq + 3 JOIN control_task t ON t.id = a.task_id
    WHERE a.ran_at > $1::timestamptz - interval '90 days' AND (a.status = 'failed' OR a.result ILIKE 'unverified%' OR a.result ILIKE 'error%')
      AND b.status = 'done' AND b.result ILIKE 'verified%' AND b.kind <> a.kind
    GROUP BY a.kind, b.kind`, [now])).rows;
  const fails = new Map((await db.query(`SELECT kind, count(*)::int AS n FROM control_step WHERE ran_at > $1::timestamptz - interval '90 days'
    AND (status = 'failed' OR result ILIKE 'unverified%' OR result ILIKE 'error%') GROUP BY kind`, [now])).rows.map((r) => [r.kind, r.n]));
  return rows.filter((r) => r.n >= 3).map((r) => ({
    key: `recovery:${r.failed}->${r.fix}`, kind: "recovery" as const, basis: "observed" as const, scope: `j6.step:${r.failed}`, support: r.n, positives: r.n,
    confidence: wilsonLow(r.n, Math.max(r.n, Number(fails.get(r.failed) ?? r.n))),
    statement: `When "${r.failed}" did not verify, "${r.fix}" worked next ${r.n} time(s) (of ${fails.get(r.failed) ?? r.n} failures; tasks ${r.tasks.join(", ")}).`,
    lastEvidenceAt: iso(r.last), evidence: { source: "control_step pairs", window: "90 days", tasks: r.tasks },
    effect: { type: "planner_hint" as const, match: [r.failed], text: `When "${r.failed}" does not verify, "${r.fix}" has worked next (${r.n} times).` },
  }));
}

const STOP = new Set(["the", "a", "an", "my", "me", "to", "of", "and", "for", "in", "on", "it", "this", "that", "please", "finagai", "with", "from", "do", "not", "is", "at", "by", "then", "julian", "test", "live"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
const NOISE = new Set(["observe", "screenshot", "wait", "done", "ask", "read_text"]);

/** The same kind of request done the same verified way ≥3 times → a PROPOSED procedure (Julian approves before use). */
export async function procedures(db: Db, now: Date): Promise<Candidate[]> {
  const tasks = (await db.query(`SELECT t.id, t.code, t.request, t.updated_at, array_agg(s.kind ORDER BY s.seq) AS kinds, array_agg(s.summary ORDER BY s.seq) AS summaries
    FROM control_task t JOIN control_step s ON s.task_id = t.id
    WHERE t.status = 'done' AND t.verification_status = 'verified' AND t.requester IS NULL AND t.updated_at > $1::timestamptz - interval '120 days' AND s.status = 'done'
    GROUP BY t.id`, [now])).rows;
  const groups = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const seq = (t.kinds as string[]).filter((k) => !NOISE.has(k)).filter((k, i, a) => i === 0 || a[i - 1] !== k);
    if (seq.length < 3 || seq.length > 15) continue;
    const sig = seq.join(">");
    groups.set(sig, [...(groups.get(sig) ?? []), { ...t, seq }]);
  }
  const out: Candidate[] = [];
  for (const [sig, g] of groups) {
    if (g.length < 3) continue;
    const common = [...new Set(words(g[0].request))].filter((w) => g.every((t) => words(t.request).includes(w)));
    if (!common.length) continue;                                              // same steps but unrelated requests: not a procedure
    const rep = g.sort((a, b) => Number(b.code) - Number(a.code))[0];
    const steps = (rep.kinds as string[]).map((k: string, i: number) => [k, String(rep.summaries[i])] as const).filter(([k]) => !NOISE.has(k)).map(([k, s]) => `${k}: ${s}`.slice(0, 200));
    const name = `${common.slice(0, 4).join(" ")} (${rep.seq.length} steps)`;
    out.push({ key: `procedure:${sig}:${common.slice(0, 4).sort().join("+")}`, kind: "procedure", basis: "inferred", scope: `j6.request:${common.join(" ")}`, support: g.length, positives: g.length,
      confidence: Math.min(0.95, 1 - 1 / (g.length + 1)), lastEvidenceAt: iso(g.map((t) => t.updated_at).sort().pop()),
      statement: `Requests about "${common.join(" ")}" were completed and verified the same way ${g.length} times (tasks ${g.map((t) => t.code).join(", ")}): ${rep.seq.join(" → ")}.`,
      evidence: { source: "control_task (verified)", tasks: g.map((t) => Number(t.code)), representative: Number(rep.code) },
      effect: { type: "procedure", name, when: common.slice(0, 6), steps } });
  }
  return out;
}

const LET_RIDE = /\b(let (?:it )?ride|skip|no (?:follow|nudge)|don'?t (?:follow|nudge)|not now|ignore|leave it|pass)\b/i;

/** How Julian actually decides what Finagai escalates — a stable pattern becomes a PROPOSED policy change. */
export async function decisionPatterns(db: Db, _now: Date): Promise<Candidate[]> {
  const rows = (await db.query(`SELECT f.rule, COALESCE(f.area_id, p.area_id) AS area_id, a.name AS area, f.state, f.outcome, e.resolved_at
    FROM escalation e JOIN followup f ON f.id = e.followup_id LEFT JOIN project p ON p.id = f.project_id LEFT JOIN area a ON a.id = COALESCE(f.area_id, p.area_id)
    WHERE e.status = 'resolved' AND f.rule IS NOT NULL`)).rows;
  const by = new Map<string, typeof rows>();
  for (const r of rows) { const k = `${r.area_id}|${r.rule}`; by.set(k, [...(by.get(k) ?? []), r]); }
  const out: Candidate[] = [];
  for (const [k, g] of by) {
    const ride = g.filter((r) => r.state === "cancelled" || LET_RIDE.test(String(r.outcome ?? ""))).length;
    const [areaId, rule] = k.split("|");
    const area = g[0].area ?? "Career";
    const last = iso(g.map((r) => r.resolved_at).sort().pop());
    const base: Omit<Candidate, "key" | "statement" | "effect" | "basis" | "confidence"> = { kind: "decision_pattern", areaId: areaId === "null" ? null : areaId!, scope: `decision:${rule}`, support: g.length, positives: ride, lastEvidenceAt: last,
      evidence: { source: "escalation + followup outcomes", rule, resolved: g.length, letRide: ride } };
    out.push({ ...base, key: `decision:${areaId}:${rule}`, basis: "observed", confidence: wilsonLow(ride, g.length),
      statement: `${area}: when Finagai asked about "${rule}", Julian let it ride ${ride}/${g.length} times.`, effect: null });
    if (rule === "applied.nudge_or_let_go" && g.length >= 5 && ride / g.length >= 0.8 && (await policyFor(db, areaId === "null" ? null : areaId)).nudgeWithContact)
      out.push({ ...base, key: `decision:${areaId}:${rule}:policy`, basis: "inferred", confidence: wilsonLow(ride, g.length),
        statement: `${area}: stop asking about nudging silent applications — Julian let ${ride} of ${g.length} ride. Silence would then close quietly (sending stays his if he ever wants it).`,
        effect: { type: "policy_param", area, param: "nudgeWithContact", value: false } });
  }
  return out;
}

const RESPONSE_KINDS = ["screen", "interview", "rejection", "offer"];
const quant = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!; };

/** What actually happens after an application / submission, per Area (any opportunity kind). */
export async function outcomes(db: Db, _now: Date): Promise<Candidate[]> {
  const rows = (await db.query(`SELECT o.id, o.area_id, a.name AS area, o.kind,
      (SELECT min(at) FROM opportunity_event e WHERE e.opportunity_id = o.id AND e.kind = 'application') AS applied,
      (SELECT summary FROM opportunity_event e WHERE e.opportunity_id = o.id AND e.kind = 'application' ORDER BY at LIMIT 1) AS app_summary,
      (SELECT min(at) FROM opportunity_event e WHERE e.opportunity_id = o.id AND e.kind = ANY($1::text[])) AS responded,
      (SELECT kind FROM opportunity_event e WHERE e.opportunity_id = o.id AND e.kind = ANY($1::text[]) ORDER BY at LIMIT 1) AS first_answer,
      (SELECT bool_or(e.kind IN ('screen','interview','offer')) FROM opportunity_event e WHERE e.opportunity_id = o.id) AS advanced,
      (SELECT max(at) FROM opportunity_event e WHERE e.opportunity_id = o.id) AS last
    FROM opportunity o LEFT JOIN area a ON a.id = o.area_id WHERE o.archived_at IS NULL`, [RESPONSE_KINDS])).rows.filter((r) => r.applied);
  const out: Candidate[] = [];
  const byArea = new Map<string, typeof rows>();
  for (const r of rows) byArea.set(String(r.area_id), [...(byArea.get(String(r.area_id)) ?? []), r]);
  for (const [areaId, g] of byArea) {
    const area = g[0].area ?? "?";
    const last = iso(g.map((r) => r.last).sort().pop());
    const answered = g.filter((r) => r.responded && new Date(r.responded) >= new Date(r.applied));
    const lat = answered.map((r) => (new Date(r.responded).getTime() - new Date(r.applied).getTime()) / 86_400_000);
    const rejections = answered.filter((r) => r.first_answer === "rejection").length;
    const mix = `${rejections} of the ${lat.length} answers were rejections`;
    if (lat.length >= 3) {
      const med = Math.round(quant(lat, 0.5)), p80 = Math.round(quant(lat, 0.8));
      out.push({ key: `outcome:${areaId}:response_days`, kind: "outcome", basis: "observed", areaId, scope: `area:${area}`, support: lat.length, confidence: Math.min(0.95, 1 - 1 / (lat.length + 1)),
        statement: `${area}: employers who answered did so in a median of ${med} days (80% within ${p80} days; ${lat.length} answers of ${g.length} applications; ${mix}).`,
        lastEvidenceAt: last, evidence: { source: "opportunity_event", applications: g.length, answers: lat.length, rejections, medianDays: med, p80Days: p80 } });
      const current = (await policyFor(db, areaId === "null" ? null : areaId)).responseDays;      // what is in effect now (defaults + approvals)
      if (lat.length >= 8 && Math.abs(p80 - current) >= 5) {
        const value = Math.min(45, Math.max(7, p80));
        out.push({ key: `outcome:${areaId}:response_days:policy`, kind: "outcome", basis: "inferred", areaId, scope: `area:${area}`, support: lat.length, confidence: Math.min(0.9, 1 - 1 / (lat.length + 1)),
          statement: `${area}: wait ${value} days (not ${current}) before treating an application as unanswered — 80% of answers came within ${p80} days (${lat.length} answers of ${g.length} applications; ${mix}; applications never answered are not in this figure).`,
          lastEvidenceAt: last, evidence: { source: "opportunity_event", p80Days: p80, answers: lat.length, applications: g.length, rejections }, effect: { type: "policy_param", area, param: "responseDays", value } });
      }
    }
    const channel = (s: string) => (/application was sent to|application to .+ at /i.test(s) ? "LinkedIn" : "direct (employer site / ATS)");
    const ch = new Map<string, { n: number; adv: number; ans: number }>();
    for (const r of g) { const c = channel(String(r.app_summary ?? "")); const v = ch.get(c) ?? { n: 0, adv: 0, ans: 0 }; v.n++; if (r.advanced) v.adv++; if (r.responded) v.ans++; ch.set(c, v); }
    for (const [c, v] of ch) if (v.n >= 5) out.push({ key: `outcome:${areaId}:channel:${c}`, kind: "outcome", basis: "observed", areaId, scope: `area:${area}`, support: v.n, positives: v.adv,
      confidence: wilsonLow(v.adv, v.n), lastEvidenceAt: last, evidence: { source: "opportunity_event", channel: c, ...v },
      statement: `${area}: ${c} applications — ${v.ans}/${v.n} got any answer, ${v.adv}/${v.n} advanced to a screen or interview.` });
  }
  return out;
}

/** Julian's corrections: write steps he declined, and how he settles conflicts between new and stored facts. */
export async function corrections(db: Db, now: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const steps = (await db.query(`SELECT kind, count(*)::int AS n, count(*) FILTER (WHERE status = 'rejected')::int AS rejected, max(decided_at) AS last,
      (array_agg(code::text ORDER BY decided_at DESC) FILTER (WHERE status = 'rejected'))[1:10] AS codes
    FROM control_step WHERE risk = 'write' AND decided_at IS NOT NULL AND decided_at > $1::timestamptz - interval '90 days' GROUP BY kind`, [now])).rows;
  for (const s of steps) if (s.rejected >= 3) out.push({ key: `correction:step:${s.kind}`, kind: "correction", basis: "observed", scope: `j6.step:${s.kind}`, support: s.n, positives: s.rejected,
    confidence: wilsonLow(s.rejected, s.n), lastEvidenceAt: iso(s.last), evidence: { source: "control_step (Julian's decisions)", window: "90 days", rejectedSteps: s.codes },
    statement: `Julian declined ${s.rejected} of ${s.n} proposed "${s.kind}" write steps in the last 90 days.`,
    effect: s.rejected / s.n >= 0.5 ? { type: "planner_hint", match: [s.kind], text: `Julian declined ${s.rejected}/${s.n} proposed "${s.kind}" steps recently: say exactly what the step changes and why, and prefer a read-only check first.` } : null });
  const conflicts = (await db.query(`SELECT existing_type, field, count(*)::int AS n, count(*) FILTER (WHERE status = 'keep_existing')::int AS kept, max(resolved_at) AS last
    FROM conflict WHERE status <> 'open' AND resolved_at > $1::timestamptz - interval '180 days' GROUP BY 1, 2`, [now])).rows;
  for (const c of conflicts) if (c.n >= 3) out.push({ key: `correction:conflict:${c.existing_type}.${c.field}`, kind: "correction", basis: "observed", scope: `conflict:${c.existing_type}.${c.field}`,
    support: c.n, positives: c.kept, confidence: wilsonLow(Math.max(c.kept, c.n - c.kept), c.n), lastEvidenceAt: iso(c.last), evidence: { source: "conflict resolutions", window: "180 days", kept: c.kept, total: c.n },
    statement: `When a new capture conflicted with a stored ${c.existing_type} ${c.field}, Julian kept the stored value ${c.kept}/${c.n} times.`, effect: null });
  return out;
}

export const LEARNERS = { resourcePerformance, recoveries, procedures, decisionPatterns, outcomes, corrections } as const;
