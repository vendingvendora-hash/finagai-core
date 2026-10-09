/**
 * Phase 3C (ADR-079) — staged bootstrap of real operational state, starting with Career.
 *
 *   discover → extract → link → identify conflicts → concise PROPOSAL → Julian approves → apply
 *
 * Sources (read-only, already authorized): the Career Copilot job-history sheet (Drive), interview/recruiter
 * evidence in Gmail and Calendar, and Finagai's existing projects. Nothing is written until Julian applies the
 * proposal by its short code. It does NOT ingest everything: analyzed postings become pipeline records
 * (opportunity), and only opportunities with real engagement evidence become projects with follow-ups.
 */
import type pg from "pg";
import { appendEvent, withTransaction } from "../db/index.js";
import type { GoogleSearch } from "../resources/retrieve.js";
import { ensureArea } from "./operating.js";
import { acquireCareerSnapshot, evidenceRecords, interpretCareer, interpretationDigest, opportunitySetDigest, snapshotDelta, snapshotDigest, INTERPRETER_VERSION,
  type CareerInterpretation, type CareerSnapshot, type CareerSources, type SnapshotDelta } from "./career-evidence.js";

export const CAREER_SHEET = "Career Copilot - Job History";

/** RFC-4180 CSV (quotes, embedded commas/newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export const normOrg = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/\b(inc|llc|ltd|corp|corporation|co|company|the|group)\b\.?/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
export const dedupeKey = (org: string, title: string, url?: string | null) => {
  const u = url && /linkedin\.com\/jobs\/view\/(\d+)/.exec(url)?.[1];
  return u ? `linkedin:${u}` : `${normOrg(org)}|${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
};

const STATUS_MAP: Record<string, string> = { analyzed: "analyzed", shortlisted: "shortlisted", applied: "applied", interviewing: "interviewing", interview: "interviewing",
  offer: "offer", rejected: "rejected", declined: "withdrawn", withdrawn: "withdrawn", closed: "closed", preparing: "preparing", "ready for review": "ready_for_review" };

export interface SheetOpportunity { sourceId: string; org: string; title: string; url: string | null; location: string | null; workMode: string | null; salary: string | null;
  eligibility: string | null; status: string; fitScore: number | null; fitNotes: string | null; resume: string | null; nextAction: string | null; nextActionAt: string | null; folder: string | null; updatedAt: string | null }

/** Map the Career Copilot sheet by HEADER NAME (column order may change). Test/diagnostic rows are dropped. */
export function extractSheet(csv: string): { rows: SheetOpportunity[]; dropped: number; duplicates: number } {
  const [header, ...data] = parseCsv(csv);
  if (!header) return { rows: [], dropped: 0, duplicates: 0 };
  const col = (re: RegExp) => header.findIndex((h) => re.test(h.trim()));
  const c = { id: col(/^job id$/i), org: col(/^company$/i), title: col(/^title$/i), url: col(/posting url/i), loc: col(/^location$/i), mode: col(/work mode/i),
    salary: col(/salary/i), elig: col(/eligibility status/i), status: col(/application status/i), score: col(/match score/i), concerns: col(/fit concerns/i),
    resume: col(/latest resume/i), next: col(/^next action$/i), nextAt: col(/next action date/i), folder: col(/job folder/i), updated: col(/date last updated/i) };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "") || null;
  const out: SheetOpportunity[] = []; let dropped = 0; const seen = new Set<string>(); let duplicates = 0;
  for (const r of data) {
    const org = get(r, c.org), title = get(r, c.title);
    const isTest = !!org && !!title && /\b(test|diagnostics?|verify)\b/i.test(org) && /\b(test|qa|verification|readable)\b/i.test(title);
    if (!org || !title || isTest) { dropped++; continue; }
    const key = dedupeKey(org, title, get(r, c.url));
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const score = Number(get(r, c.score));
    out.push({ sourceId: get(r, c.id) ?? key, org, title, url: get(r, c.url), location: get(r, c.loc), workMode: get(r, c.mode), salary: get(r, c.salary),
      eligibility: get(r, c.elig), status: STATUS_MAP[(get(r, c.status) ?? "analyzed").toLowerCase()] ?? "analyzed",
      fitScore: Number.isFinite(score) && score > 0 ? Math.round(score) : null, fitNotes: get(r, c.concerns), resume: get(r, c.resume),
      nextAction: get(r, c.next), nextActionAt: get(r, c.nextAt), folder: get(r, c.folder), updatedAt: get(r, c.updated) });
  }
  return { rows: out, dropped, duplicates };
}

export interface Engagement { org: string; kind: "interview" | "screen" | "recruiter" | "application"; when: string | null; subject: string; contact: string | null; source: "gmail" | "calendar" }

const ORG_AFTER = /\b([Pp]hone [Ss]creen|[Ii]nterview|[Aa]pplication)\b[^A-Za-z]{0,3}(?:with|for|at|to)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/;
const ORG = "([A-Z][\\w&.'-]*(?:\\s+[A-Z][\\w&.'-]*){0,4})";
/** LinkedIn/ATS application notices (live: "Your application to Senior Financial Planning Analyst at Transurban"). */
const APPLICATION_NOTICE = [
  new RegExp(`application to (.{3,120}?) at ${ORG}`),
  new RegExp(`application was (?:sent to|viewed by|received by) ${ORG}`),
  new RegExp(`(?:applied|applying) (?:to|for) (?:.{3,120}? at )?${ORG}`),
];
function engagementFrom(subj: string, text: string, when: string | null, source: "gmail" | "calendar"): Engagement | null {
  for (const re of APPLICATION_NOTICE) {
    const a = re.exec(subj);
    if (a) {
      const org = (a[2] ?? a[1])!.trim();
      if (org && !/^(Senior|Junior|Lead|Principal|Financial|Pricing|Analyst|LinkedIn|Indeed)\b/.test(org))
        return { org, kind: "application", when, subject: subj.slice(0, 160), contact: null, source };
    }
  }
  const m = ORG_AFTER.exec(subj);
  if (!m) return null;
  const org = m[2]!.replace(/\s+(Pricing|Senior|Financial|Analyst|Role|Position|Julian)\b.*$/, "").trim();
  if (!org || /^(Julian|Your|The|A|An|Us|Me)$/i.test(org)) return null;
  // Live: "Senior" became an org from a LinkedIn application email ("application for Senior Financial Analyst").
  if (/^(Senior|Junior|Lead|Principal|Staff|Associate|Assistant|Financial|Finance|Pricing|Accounting|Business|Data|Cost|Budget|Program|Analyst|Manager|Director|Specialist|Coordinator|Consultant|FP|Sr|Jr)\b/i.test(org)) return null;
  const kind: Engagement["kind"] = /screen/i.test(m[1]!) ? "screen" : /interview/i.test(m[1]!) ? "interview" : "application";
  const from = /From:\s*"?([^<"\n]+?)"?\s*</.exec(text)?.[1]?.trim() ?? null;
  return { org, kind, when, subject: subj.slice(0, 160), contact: from && !/julian|otter|no-?reply/i.test(from) ? from : null, source };
}

/** Interview / screen / application evidence from Gmail results (one per thread) and Calendar results (many events per excerpt). */
export function extractEngagement(items: Array<{ name: string; text: string; modified?: string }>, source: "gmail" | "calendar"): Engagement[] {
  const out: Engagement[] = [];
  for (const it of items) {
    if (source === "calendar") {
      for (const ev of it.text.split(/(?=\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)) {
        const [when, title] = ev.split("|").map((x) => x.trim());
        if (!when || !title || !/^\d{4}-\d{2}-\d{2}T/.test(when)) continue;
        const e = engagementFrom(title, ev, when, "calendar"); if (e) out.push(e);
      }
      continue;
    }
    const subj = it.name.replace(/^Gmail:\s*/, "").replace(/\s*\[[^\]]+\]$/, "").replace(/^(re|fwd?|canceled|cancelled|updated invitation):\s*/i, "");
    const dateTxt = /Date:\s*([^\n]+?\d{4}[^\n]*?[+-]\d{4})/.exec(it.text)?.[1];
    const when = it.modified ?? (dateTxt && !Number.isNaN(Date.parse(dateTxt)) ? new Date(Date.parse(dateTxt)).toISOString() : null);
    const e = engagementFrom(subj, it.text, when, "gmail"); if (e) out.push(e);
  }
  return out;
}

export interface ActiveProjectProposal { org: string; orgKey: string; aliases: string[]; status: string; titles: string[]; evidence: string[]; evidenceIds: string[];
  lastContact: string | null; contact: string | null; proposedFollowup: string | null; followupDue: string | null; existingProject: string | null }
export interface BootstrapOpportunity extends SheetOpportunity { dedupe: string; aliasKeys: string[]; evidenceIds: string[]; statusSource: "sheet" | "evidence" }
export interface BootstrapPayload {
  area: string; objective: { proposed: string; needsConfirmation: boolean };
  source: { sheet: string | null; sheetId: string | null; account: string | null; rows: number; dropped: number; duplicates: number };
  provenance?: { snapshotId: string; acquisitionId: string; snapshotDigest: string; interpretationDigest: string; opportunitySetDigest: string; interpreterVersion: string;
    acquiredAt: string; asOf: string; complete: boolean; problems: string[]; searchMisses: number; records: number; previousSnapshot: string | null };
  applicable?: { ok: boolean; why: string[] };
  pipeline: { total: number; byStatus: Record<string, number>; shortlist: Array<{ org: string; title: string; score: number | null; eligibility: string | null }> };
  activeProjects: ActiveProjectProposal[];
  closed?: Array<{ org: string; status: string; lastEvidence: string | null; evidenceIds: string[] }>;
  conflicts: string[];
  delta?: SnapshotDelta | null;
  opportunities: BootstrapOpportunity[] | SheetOpportunity[];
}

/** The stored snapshot that carry-forward and deltas compare against: the latest COMPLETE acquisition. */
export async function latestCareerSnapshot(pool: pg.Pool, area = "Career"): Promise<{ id: string; digest: string; snapshot: CareerSnapshot } | null> {
  const r = await pool.query(`SELECT s.id, s.digest, s.payload FROM evidence_acquisition a JOIN evidence_snapshot s ON s.id = a.snapshot_id
    WHERE a.area = $1 AND a.complete ORDER BY a.acquired_at DESC, a.created_at DESC LIMIT 1`, [area]);
  return r.rows[0] ? { id: r.rows[0].id, digest: r.rows[0].digest, snapshot: r.rows[0].payload as CareerSnapshot } : null;
}

/** ACQUIRE + store (content-addressed) + record the run. Never interprets. */
export async function acquireAndStoreCareer(pool: pg.Pool, google: CareerSources, now = new Date()) {
  const prev = await latestCareerSnapshot(pool);
  const snapshot = await acquireCareerSnapshot(google, CAREER_SHEET, now, prev ? { digest: prev.digest, snapshot: prev.snapshot } : null);
  const digest = snapshotDigest(snapshot);
  const records = evidenceRecords(snapshot).length;
  const ins = await pool.query(`INSERT INTO evidence_snapshot (area, digest, interpreter_version, acquired_at, complete, record_count, payload) VALUES ('Career', $1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (area, digest) DO UPDATE SET area = EXCLUDED.area RETURNING id`, [digest, INTERPRETER_VERSION, snapshot.acquiredAt, snapshot.completeness.complete, records, JSON.stringify(snapshot)]);
  const snapshotId = String(ins.rows[0].id);
  const stats = { gmail: snapshot.gmail.map((g) => ({ key: g.key, account: g.account, ok: g.ok, pages: g.pages, ids: g.ids, records: g.records.length, truncated: g.truncated, vanished: g.vanished.length })),
    carryForward: snapshot.carryForward.map((c) => ({ account: c.account, requested: c.requested, recovered: c.records.length, missing: c.missing })),
    // Exact source record ids of THIS run (the stored snapshot is content-addressed and may come from an earlier run).
    ids: Object.fromEntries([...snapshot.gmail.map((g) => [`${g.key}@${g.account}`, g.records.map((r) => r.id).sort()]),
      ...snapshot.carryForward.map((c) => [`carry-forward@${c.account}`, c.records.map((r) => r.id).sort()]), ...snapshot.calendar.map((c) => [`cal:${c.query}@${c.account}`, c.records.map((r) => r.id).sort()])]),
    calendar: snapshot.calendar.map((c) => ({ query: c.query, account: c.account, ok: c.ok, records: c.records.length })), sheet: { id: snapshot.sheet.id ?? null, sha256: snapshot.sheet.sha256 ?? null, mutated: snapshot.sheet.mutatedDuringRun ?? false } };
  const acq = await pool.query(`INSERT INTO evidence_acquisition (area, snapshot_id, acquired_at, complete, search_misses, problems, stats) VALUES ('Career', $1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
    [snapshotId, snapshot.acquiredAt, snapshot.completeness.complete, snapshot.completeness.searchMisses, JSON.stringify(snapshot.completeness.problems), JSON.stringify(stats)]);
  return { snapshot, digest, snapshotId, acquisitionId: String(acq.rows[0].id), prev, records, stats };
}

/** Pure: interpretation → proposal payload (opportunities carry stable identity: canonical key + every alias). */
export function buildCareerPayload(interp: CareerInterpretation, snapshot: CareerSnapshot, projects: string[]): Omit<BootstrapPayload, "provenance" | "delta" | "applicable"> {
  const sheet = snapshot.sheet.ok && snapshot.sheet.csv ? extractSheet(snapshot.sheet.csv) : { rows: [] as SheetOpportunity[], dropped: 0, duplicates: 0 };
  const orgs = new Map<string, { status: string; aliases: string[]; ids: string[] }>();
  for (const o of interp.traces.orgs) for (const a of o.aliases) orgs.set(a, { status: o.status, aliases: o.aliases, ids: o.records.map((r) => r.recordId) });
  const covered = new Set<string>();
  const opportunities: BootstrapOpportunity[] = sheet.rows.map((r) => {
    const o = orgs.get(normOrg(r.org));
    if (o) o.aliases.forEach((a) => covered.add(a));
    return { ...r, status: o ? o.status : r.status, statusSource: o && o.ids.length ? "evidence" : "sheet", dedupe: dedupeKey(r.org, r.title, r.url), aliasKeys: [dedupeKey(r.org, r.title, r.url)], evidenceIds: o?.ids ?? [] };
  });
  for (const o of [...interp.active, ...interp.closed.map((c) => ({ ...c, titles: [] as string[], evidence: c.evidenceIds.map((id) => ({ recordId: id })) }))]) {
    if (o.aliases.some((a) => covered.has(a))) continue;
    opportunities.push({ sourceId: `evidence:${o.orgKey}`, org: o.org, title: o.titles[0] ?? "(role from email evidence)", url: null, location: null, workMode: null, salary: null, eligibility: null,
      status: o.status, fitScore: null, fitNotes: null, resume: null, nextAction: null, nextActionAt: null, folder: null, updatedAt: null,
      statusSource: "evidence", dedupe: `org:${o.orgKey}`, aliasKeys: o.aliases.map((a) => `org:${a}`).sort(), evidenceIds: o.evidence.map((e) => e.recordId) });
  }
  const projKeys = new Map(projects.map((p) => [normOrg(p), p]));
  const activeProjects: ActiveProjectProposal[] = interp.active.map((a) => ({
    org: a.org, orgKey: a.orgKey, aliases: a.aliases, status: a.status, titles: a.titles,
    evidence: a.evidence.map((e) => `${e.kind} ${e.at.slice(0, 10)}: ${e.subject}`), evidenceIds: a.evidence.map((e) => e.recordId),
    lastContact: a.lastEvidenceAt, contact: a.contact, proposedFollowup: a.followup, followupDue: a.followupDue,
    existingProject: a.aliases.map((k) => projKeys.get(k)).find(Boolean) ?? null }));
  const byStatus: Record<string, number> = {};
  for (const o of opportunities) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  return {
    area: "Career", objective: { proposed: "Secure a strong Financial / Pricing Analyst role", needsConfirmation: true },
    source: { sheet: snapshot.sheet.name ?? null, sheetId: snapshot.sheet.id ?? null, account: snapshot.sheet.account ?? null, rows: sheet.rows.length, dropped: sheet.dropped, duplicates: sheet.duplicates },
    pipeline: { total: opportunities.length, byStatus, shortlist: interp.pipeline.shortlist },
    activeProjects, closed: interp.closed.map((c) => ({ org: c.org, status: c.status, lastEvidence: c.lastEvidenceAt, evidenceIds: c.evidenceIds })),
    conflicts: interp.conflicts, opportunities,
  };
}

/**
 * ADR-080: acquisition → frozen snapshot → pure interpretation → proposal with full provenance and a delta against the
 * previous snapshot. A proposal is APPLICABLE only if its snapshot is complete and every opportunity change since the
 * previous snapshot is explained by specific source records.
 */
export async function proposeCareerBootstrap(pool: pg.Pool, google: GoogleSearch | undefined, now = new Date()) {
  const src = (google ?? {}) as CareerSources;
  const acq = await acquireAndStoreCareer(pool, src, now);
  const asOf = now.toISOString();
  const interp = interpretCareer(acq.snapshot, { asOf });
  const delta = acq.prev ? snapshotDelta(acq.prev.snapshot, acq.snapshot, { asOfPrev: asOf, asOfCur: asOf }) : null;
  const projects = (await pool.query(`SELECT name FROM project WHERE archived_at IS NULL AND NOT is_unassigned_holding`)).rows.map((r) => String(r.name));
  const why = [...(acq.snapshot.completeness.complete ? [] : [`incomplete snapshot: ${acq.snapshot.completeness.problems.join("; ")}`]),
    ...(delta?.unexplained.length ? [`unexplained change since the previous snapshot: ${delta.unexplained.join(", ")}`] : [])];
  const provenance = { snapshotId: acq.snapshotId, acquisitionId: acq.acquisitionId, snapshotDigest: acq.digest, interpretationDigest: interpretationDigest(interp), opportunitySetDigest: opportunitySetDigest(interp),
    interpreterVersion: INTERPRETER_VERSION, acquiredAt: acq.snapshot.acquiredAt, asOf: interp.asOf, complete: acq.snapshot.completeness.complete, problems: acq.snapshot.completeness.problems,
    searchMisses: acq.snapshot.completeness.searchMisses, records: acq.records, previousSnapshot: acq.prev?.digest ?? null };
  const payload: BootstrapPayload = { ...buildCareerPayload(interp, acq.snapshot, projects), provenance, applicable: { ok: why.length === 0, why }, delta };
  const r = await pool.query(`INSERT INTO bootstrap_proposal (area, payload, snapshot_id, acquisition_id, snapshot_digest, interpretation_digest, opportunity_set_digest, interpreter_version)
    VALUES ('Career', $1::jsonb, $2, $3, $4, $5, $6, $7) RETURNING code`,
    [JSON.stringify(payload), acq.snapshotId, acq.acquisitionId, acq.digest, provenance.interpretationDigest, provenance.opportunitySetDigest, INTERPRETER_VERSION]);
  const { opportunities: _omit, ...summary } = payload;
  return { code: Number(r.rows[0].code), summary, interp };
}

/** Apply an approved proposal: area, (confirmed) objective, pipeline records, engaged projects + follow-ups. Idempotent.
 *  Stable identity: an opportunity is matched by ANY of its alias keys; nothing is ever deleted. */
export async function applyBootstrap(pool: pg.Pool, code: number, opts: { objective?: string | null; skipFollowups?: boolean } = {}) {
  const p = (await pool.query(`SELECT id, status, payload FROM bootstrap_proposal WHERE code = $1`, [code])).rows[0];
  if (!p) return { error: `No bootstrap proposal ${code}.` };
  if (p.status !== "pending") return { error: `Bootstrap proposal ${code} is already ${p.status}.` };
  const pl = p.payload as BootstrapPayload;
  if (pl.applicable && !pl.applicable.ok) return { error: `Bootstrap proposal ${code} is not applicable: ${pl.applicable.why.join("; ")}` };
  const area = await ensureArea(pool, pl.area);
  return withTransaction(pool, async (tx) => {
    let objectiveId: string | null = null;
    const objName = opts.objective ?? pl.objective.proposed;
    const ob = await tx.query(`SELECT id FROM objective WHERE area_id = $1 AND lower(name) = lower($2)`, [area.id, objName]);
    objectiveId = ob.rows[0]?.id ?? (await tx.query(`INSERT INTO objective (area_id, name) VALUES ($1, $2) RETURNING id`, [area.id, objName])).rows[0].id;
    let upserted = 0;
    for (const raw of pl.opportunities) {
      const o = raw as BootstrapOpportunity;
      const key = o.dedupe ?? dedupeKey(o.org, o.title, o.url);
      const aliases = o.aliasKeys?.length ? o.aliasKeys : [key];
      const details = JSON.stringify({ folder: o.folder, sheetUpdatedAt: o.updatedAt, aliasKeys: aliases, evidenceIds: o.evidenceIds ?? [], statusSource: o.statusSource ?? "sheet" });
      const existing = await tx.query(`SELECT id FROM opportunity WHERE kind = 'job' AND archived_at IS NULL AND dedupe_key = ANY($1::text[]) ORDER BY created_at LIMIT 1`, [[key, ...aliases]]);
      if (existing.rows[0]) {
        await tx.query(`UPDATE opportunity SET status = $2, fit_score = COALESCE($3, fit_score), details = details || $4::jsonb, updated_at = now() WHERE id = $1`, [existing.rows[0].id, o.status, o.fitScore, details]);
      } else {
        await tx.query(
          `INSERT INTO opportunity (kind, area_id, org, title, url, location, work_mode, salary, eligibility, status, fit_score, fit_notes, resume_ref, next_action, next_action_at, source, dedupe_key, details)
           VALUES ('job', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
          [area.id, o.org, o.title, o.url, o.location, o.workMode, o.salary, o.eligibility, o.status, o.fitScore, o.fitNotes, o.resume, o.nextAction,
           o.nextActionAt && !Number.isNaN(Date.parse(o.nextActionAt)) ? o.nextActionAt : null, o.sourceId.startsWith("evidence:") ? "gmail" : `career_copilot:${o.sourceId}`, key, details]);
      }
      upserted++;
    }
    const created: string[] = [];
    for (const a of pl.activeProjects) {
      let pid: string;
      const names = [a.existingProject, a.org].filter((x): x is string => !!x);
      const ex = await tx.query(`SELECT id FROM project WHERE archived_at IS NULL AND lower(name) = ANY($1::text[]) ORDER BY created_at LIMIT 1`, [names.map((n) => n.toLowerCase())]);
      if (ex.rows[0]) pid = ex.rows[0].id;
      else { pid = (await tx.query(`INSERT INTO project (name, description, last_activity_at) VALUES ($1, $2, now()) RETURNING id`, [a.org, `Job opportunity (${a.status}; ${a.evidence.slice(0, 3).join("; ")})`.slice(0, 500)])).rows[0].id; created.push(a.org); }
      await tx.query(`UPDATE project SET area_id = $2, objective_id = $3, updated_at = now() WHERE id = $1`, [pid, area.id, objectiveId]);
      const keys = (a.aliases ?? [normOrg(a.org)]);
      await tx.query(`UPDATE opportunity SET project_id = $2, contact = COALESCE(contact, $3) WHERE area_id = $4 AND archived_at IS NULL AND (lower(org) = lower($1) OR details->'aliasKeys' ?| $5::text[] OR dedupe_key = ANY($5::text[]))`,
        [a.org, pid, a.contact, area.id, keys.map((k) => `org:${k}`)]);
      if (a.proposedFollowup && !opts.skipFollowups) {
        const dup = await tx.query(`SELECT 1 FROM followup WHERE project_id = $1 AND state IN ('open','waiting','overdue')`, [pid]);
        if (!dup.rowCount) await tx.query(`INSERT INTO followup (summary, counterparty, state, due_at, last_action_at, area_id, project_id) VALUES ($1, $2, 'waiting', now() + interval '3 days', $3, $4, $5)`,
          [a.proposedFollowup, a.contact ?? a.org, a.lastContact ?? new Date().toISOString(), area.id, pid]);
      }
    }
    await tx.query(`UPDATE bootstrap_proposal SET status = 'applied', applied_at = now() WHERE id = $1`, [p.id]);
    await appendEvent(tx, { actor: "julian", action: "bootstrap_applied", entityType: "area", entityId: area.id, after: { code, opportunities: upserted, projectsCreated: created, snapshot: pl.provenance?.snapshotDigest ?? null } });
    return { area: area.name, objective: objName, opportunities: upserted, activeProjects: pl.activeProjects.map((a) => a.org), projectsCreated: created };
  });
}
