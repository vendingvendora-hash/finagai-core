/**
 * Phase 6 (ADR-085) — learning as a general Finagai capability. One pass: every learner reads Finagai's own records,
 * the store keeps/updates/retires lessons and routes inferred behaviour changes into governance. Runs daily from the
 * event engine (generic `learning` watcher) and on demand (run_learning, preview writes nothing).
 */
import type pg from "pg";
import { appendEvent } from "../db/index.js";
import { inTx } from "../cos/opportunities.js";
import { LEARNERS, type Candidate } from "./learners.js";
import { storeLessons, type StoreResult } from "./store.js";
import { MIN_FRESHNESS, freshness } from "./apply.js";

const LEARNING_LOCK = 85_001;

export interface LearningResult extends StoreResult { preview: boolean; candidates: number; learnerProblems: string[]; skipped?: string }

export async function runLearning(pool: pg.Pool, opts: { dryRun?: boolean; now?: Date } = {}): Promise<LearningResult> {
  const now = opts.now ?? new Date(); const dryRun = !!opts.dryRun;
  return inTx(pool, dryRun, async (tx) => {
    const got = (await tx.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [LEARNING_LOCK])).rows[0]?.ok;
    const empty: StoreResult = { learned: [], updated: 0, proposed: [], retired: [], decided: [], effectRejected: [], unchanged: 0 };
    if (!got) return { ...empty, preview: dryRun, candidates: 0, learnerProblems: [], skipped: "another learning pass is running" };
    const candidates: Candidate[] = []; const learnerProblems: string[] = [];
    for (const [name, learn] of Object.entries(LEARNERS)) {
      // One learner failing never blocks the others (a savepoint keeps the transaction usable).
      await tx.query(`SAVEPOINT learner`);
      try { candidates.push(...await learn(tx, now)); await tx.query(`RELEASE SAVEPOINT learner`); }
      catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT learner`); learnerProblems.push(`${name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`); }
    }
    const r = await storeLessons(tx, candidates, now);
    if (!dryRun) await appendEvent(tx, { actor: "cos", action: "learning_ran", after: { candidates: candidates.length, learned: r.learned.length, updated: r.updated, proposed: r.proposed.length, retired: r.retired.length, decided: r.decided.length, problems: learnerProblems } });
    return { ...r, preview: dryRun, candidates: candidates.length, learnerProblems };
  });
}

/** Read-only view of what Finagai has learned: by basis, with provenance, confidence and freshness. */
export async function listLessons(db: Pick<pg.Pool, "query">, opts: { status?: string; limit?: number } = {}, now = new Date()) {
  const rows = (await db.query(`SELECT l.key, l.kind, l.basis, l.scope, l.statement, l.effect, l.support, l.positives, l.confidence, l.evidence, l.first_seen_at, l.last_evidence_at, l.status,
        l.retired_reason, a.name AS area, p.status AS proposal_status, p.id AS proposal_id,
        (SELECT count(*)::int FROM event e WHERE e.action = 'lesson_applied' AND e.after->'keys' ? l.key) AS applied
      FROM lesson l LEFT JOIN area a ON a.id = l.area_id LEFT JOIN proposal p ON p.id = l.proposal_id
     WHERE ($1::text IS NULL AND l.status <> 'retired' OR l.status = $1) ORDER BY l.status, l.basis, l.confidence DESC LIMIT $2`, [opts.status ?? null, opts.limit ?? 50])).rows;
  const BASIS = { observed: "observed fact (from Finagai's own records)", stated: "Julian said so", inferred: "inference (applies only once Julian approves)" } as const;
  const lessons = rows.map((l) => {
    const f = l.basis === "stated" ? 1 : freshness(l.last_evidence_at, now);
    return {
      key: l.key, area: l.area, kind: l.kind, basis: BASIS[l.basis as keyof typeof BASIS], status: l.status, statement: l.statement,
      effect: l.effect, confidence: Number(l.confidence), support: l.support, positives: l.positives,
      freshness: Number(f.toFixed(2)), applies: l.effect ? (l.status === "active" && f >= MIN_FRESHNESS ? "yes (advisory/as stated)" : l.status === "approved" ? "yes (approved by Julian)" : l.status === "proposed" ? "only after Julian approves" : "no") : "informational",
      provenance: l.evidence, firstSeen: l.first_seen_at, lastEvidence: l.last_evidence_at, timesUsedByPlanner: l.applied,
      ...(l.proposal_id ? { proposal: { id: l.proposal_id, status: l.proposal_status } } : {}), ...(l.retired_reason ? { retired: l.retired_reason } : {}),
    };
  });
  const counts = (await db.query(`SELECT status, basis, count(*)::int AS n FROM lesson GROUP BY 1, 2`)).rows;
  return { counts: counts.map((c) => `${c.status}/${c.basis}: ${c.n}`), lessons };
}

export { guidanceFor, routingOverride, policyFor } from "./apply.js";
