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
import { GMAIL_EXTRACTOR, type GmailRecord } from "../google/client.js";
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
export function extractSheet(csv: string): { rows: SheetOpportunity[]; dropped: number; duplicates: number; duplicateRows: Array<{ id: string; sameAs: string; key: string }> } {
  const [header, ...data] = parseCsv(csv);
  if (!header) return { rows: [], dropped: 0, duplicates: 0, duplicateRows: [] };
  const col = (re: RegExp) => header.findIndex((h) => re.test(h.trim()));
  const c = { id: col(/^job id$/i), org: col(/^company$/i), title: col(/^title$/i), url: col(/posting url/i), loc: col(/^location$/i), mode: col(/work mode/i),
    salary: col(/salary/i), elig: col(/eligibility status/i), status: col(/application status/i), score: col(/match score/i), concerns: col(/fit concerns/i),
    resume: col(/latest resume/i), next: col(/^next action$/i), nextAt: col(/next action date/i), folder: col(/job folder/i), updated: col(/date last updated/i) };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "") || null;
  const out: SheetOpportunity[] = []; let dropped = 0; const seen = new Map<string, string>(); let duplicates = 0;
  const duplicateRows: Array<{ id: string; sameAs: string; key: string }> = [];
  for (const r of data) {
    const org = get(r, c.org), title = get(r, c.title);
    const isTest = !!org && !!title && /\b(test|diagnostics?|verify)\b/i.test(org) && /\b(test|qa|verification|readable)\b/i.test(title);
    if (!org || !title || isTest) { dropped++; continue; }
    const key = dedupeKey(org, title, get(r, c.url));
    // Same posting listed twice (same LinkedIn job id, or same employer + title): kept as ONE row, and the merge is reported.
    if (seen.has(key)) { duplicates++; duplicateRows.push({ id: get(r, c.id) ?? key, sameAs: seen.get(key)!, key }); continue; }
    seen.set(key, get(r, c.id) ?? key);
    const score = Number(get(r, c.score));
    out.push({ sourceId: get(r, c.id) ?? key, org, title, url: get(r, c.url), location: get(r, c.loc), workMode: get(r, c.mode), salary: get(r, c.salary),
      eligibility: get(r, c.elig), status: STATUS_MAP[(get(r, c.status) ?? "analyzed").toLowerCase()] ?? "analyzed",
      fitScore: Number.isFinite(score) && score > 0 ? Math.round(score) : null, fitNotes: get(r, c.concerns), resume: get(r, c.resume),
      nextAction: get(r, c.next), nextActionAt: get(r, c.nextAt), folder: get(r, c.folder), updatedAt: get(r, c.updated) });
  }
  return { rows: out, dropped, duplicates, duplicateRows };
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

/** One proposed project per ENGAGED job (never per employer). */
export interface ActiveProjectProposal { name: string; opportunityKey: string; employer: string; title: string | null; reqId: string | null; status: string; evidence: string[]; evidenceIds: string[];
  lastContact: string | null; contact: string | null; proposedFollowup: string | null; followupDue: string | null; existingProject: string | null }
/** A job opportunity as it would be written: its own identity, status, history, evidence, contact, dates and source ids. */
export interface BootstrapOpportunity extends SheetOpportunity {
  dedupe: string; aliasKeys: string[]; evidenceIds: string[]; statusSource: "sheet" | "evidence";
  employerKey: string; reqId: string | null; identityBasis: string; contact: string | null; firstEvidenceAt: string | null; lastEvidenceAt: string | null; appliedAt: string | null;
  events: Array<{ at: string; kind: string; transition: string; sourceId: string; subject: string }>; anomalies: string[]; sourceIds: string[];
}
export interface BootstrapEmployer { key: string; name: string; aliases: string[]; party: string; partyReason: string; jobs: number }
export interface BootstrapPayload {
  area: string; objective: { proposed: string; needsConfirmation: boolean };
  source: { sheet: string | null; sheetId: string | null; account: string | null; rows: number; dropped: number; duplicates: number; duplicateRows?: Array<{ id: string; sameAs: string; key: string }> };
  provenance?: { snapshotId: string; acquisitionId: string; snapshotDigest: string; interpretationDigest: string; opportunitySetDigest: string; interpreterVersion: string;
    acquiredAt: string; asOf: string; complete: boolean; problems: string[]; searchMisses: number; records: number; previousSnapshot: string | null };
  applicable?: { ok: boolean; why: string[] };
  pipeline: { total: number; byStatus: Record<string, number>; shortlist: Array<{ org: string; title: string; score: number | null; eligibility: string | null }> };
  employers?: BootstrapEmployer[];
  activeProjects: ActiveProjectProposal[];
  closed?: Array<{ job: string; status: string; lastEvidence: string | null; evidenceIds: string[] }>;
  pipelineOnly?: string[];
  unassigned?: Array<{ employer: string; recordId: string; at: string; kind: string; reason: string }>;
  conflicts: string[];
  delta?: SnapshotDelta | null;
  opportunities: BootstrapOpportunity[];
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
  // Immutable message content from earlier runs (same extractor) is reused; new content is stored even if this run fails.
  const known = new Map<string, Map<string, GmailRecord>>();
  for (const r of (await pool.query(`SELECT account, message_id, record FROM gmail_message_content WHERE extractor_version = $1`, [GMAIL_EXTRACTOR])).rows)
    (known.get(r.account) ?? known.set(r.account, new Map()).get(r.account)!).set(r.message_id, r.record as GmailRecord);
  const fresh: Array<[string, GmailRecord]> = [];
  let snapshot: CareerSnapshot;
  try { snapshot = await acquireCareerSnapshot(google, CAREER_SHEET, now, prev ? { digest: prev.digest, snapshot: prev.snapshot } : null, { known, onFetched: (a, r) => fresh.push([a, r]) }); }
  finally {
    for (const [account, rec] of fresh)
      await pool.query(`INSERT INTO gmail_message_content (account, message_id, extractor_version, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`, [account, rec.id, GMAIL_EXTRACTOR, JSON.stringify(rec)]);
  }
  const digest = snapshotDigest(snapshot);
  const records = evidenceRecords(snapshot).length;
  const ins = await pool.query(`INSERT INTO evidence_snapshot (area, digest, interpreter_version, acquired_at, complete, record_count, payload) VALUES ('Career', $1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (area, digest) DO UPDATE SET area = EXCLUDED.area RETURNING id`, [digest, INTERPRETER_VERSION, snapshot.acquiredAt, snapshot.completeness.complete, records, JSON.stringify(snapshot)]);
  const snapshotId = String(ins.rows[0].id);
  const stats = { gmail: snapshot.gmail.map((g) => ({ key: g.key, account: g.account, ok: g.ok, ...(g.error ? { error: g.error } : {}), pages: g.pages, ids: g.ids, records: g.records.length, truncated: g.truncated, vanished: g.vanished.length, fetched: g.fetched ?? null, reused: g.reused ?? null })),
    contentCache: { known: [...known.values()].reduce((n, m) => n + m.size, 0), newlyStored: fresh.length },
    carryForward: snapshot.carryForward.map((c) => ({ account: c.account, requested: c.requested, recovered: c.records.length, missing: c.missing })),
    // Exact source record ids of THIS run (the stored snapshot is content-addressed and may come from an earlier run).
    ids: Object.fromEntries([...snapshot.gmail.map((g) => [`${g.key}@${g.account}`, g.records.map((r) => r.id).sort()]),
      ...snapshot.carryForward.map((c) => [`carry-forward@${c.account}`, c.records.map((r) => r.id).sort()]), ...snapshot.calendar.map((c) => [`cal:${c.query}@${c.account}`, c.records.map((r) => r.id).sort()])]),
    calendar: snapshot.calendar.map((c) => ({ query: c.query, account: c.account, ok: c.ok, records: c.records.length })), sheet: { id: snapshot.sheet.id ?? null, sha256: snapshot.sheet.sha256 ?? null, mutated: snapshot.sheet.mutatedDuringRun ?? false } };
  const acq = await pool.query(`INSERT INTO evidence_acquisition (area, snapshot_id, acquired_at, complete, search_misses, problems, stats) VALUES ('Career', $1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
    [snapshotId, snapshot.acquiredAt, snapshot.completeness.complete, snapshot.completeness.searchMisses, JSON.stringify(snapshot.completeness.problems), JSON.stringify(stats)]);
  return { snapshot, digest, snapshotId, acquisitionId: String(acq.rows[0].id), prev, records, stats };
}

/** Projects (with follow-ups) only for real engagement: interviewing/offer, or an application with evidence in the last
 *  PROJECT_RECENT_DAYS. Older unanswered applications stay pipeline records — no project, no follow-up noise. */
export const PROJECT_RECENT_DAYS = 14;
const jobLabel = (o: { employer: string; title: string | null; reqId: string | null }) => `${o.employer} — ${o.title ?? "role not named in evidence"}${o.reqId ? ` (${o.reqId})` : ""}`;

/** Pure: interpretation → proposal payload. One record per JOB; Career Copilot rows not linked to evidence stay their own records. */
export function buildCareerPayload(interp: CareerInterpretation, snapshot: CareerSnapshot, projects: string[]): Omit<BootstrapPayload, "provenance" | "delta" | "applicable"> {
  const sheet = snapshot.sheet.ok && snapshot.sheet.csv ? extractSheet(snapshot.sheet.csv) : { rows: [] as SheetOpportunity[], dropped: 0, duplicates: 0, duplicateRows: [] };
  const rowById = new Map(sheet.rows.map((r) => [r.sourceId, r]));
  const linked = new Set(interp.opportunities.flatMap((o) => o.sheetRows));
  const empKeyOf = (org: string) => interp.employers.find((e) => e.aliases.includes(normOrg(org)))?.key ?? normOrg(org);
  const opportunities: BootstrapOpportunity[] = [];
  for (const o of interp.opportunities) {
    const row = o.sheetRows.length ? rowById.get(o.sheetRows[0]!) : undefined;
    opportunities.push({
      sourceId: row?.sourceId ?? o.key, org: o.employer, title: o.title ?? row?.title ?? "(role not named in evidence)", url: row?.url ?? null, location: o.location ?? row?.location ?? null,
      workMode: row?.workMode ?? null, salary: row?.salary ?? null, eligibility: row?.eligibility ?? null, status: o.status, fitScore: row?.fitScore ?? null, fitNotes: row?.fitNotes ?? null,
      resume: row?.resume ?? null, nextAction: row?.nextAction ?? null, nextActionAt: row?.nextActionAt ?? null, folder: row?.folder ?? null, updatedAt: row?.updatedAt ?? null,
      dedupe: o.key, aliasKeys: o.aliasKeys, evidenceIds: o.events.map((e) => e.recordId), statusSource: o.events.length ? "evidence" : "sheet",
      employerKey: o.employerKey, reqId: o.reqId, identityBasis: o.identityBasis, contact: o.contact, firstEvidenceAt: o.firstEvidenceAt, lastEvidenceAt: o.lastEvidenceAt, appliedAt: o.appliedAt,
      events: o.events.map((e) => ({ at: e.at, kind: e.kind, transition: e.transition, sourceId: e.recordId, subject: e.subject })), anomalies: o.anomalies, sourceIds: o.sourceIds });
  }
  for (const r of sheet.rows) {
    if (linked.has(r.sourceId)) continue;
    const key = dedupeKey(r.org, r.title, r.url);
    opportunities.push({ ...r, dedupe: key, aliasKeys: [key, `sheet:${r.sourceId}`].sort(), evidenceIds: [], statusSource: "sheet", employerKey: empKeyOf(r.org), reqId: null, identityBasis: "sheet-row",
      contact: null, firstEvidenceAt: null, lastEvidenceAt: null, appliedAt: null, events: [], anomalies: [], sourceIds: [`sheet:${r.sourceId}`] });
  }
  opportunities.sort((a, b) => (a.dedupe < b.dedupe ? -1 : a.dedupe > b.dedupe ? 1 : 0));
  const projKeys = new Map(projects.map((p) => [p.toLowerCase(), p]));
  const asOf = Date.parse(interp.asOf);
  const engaged = interp.active.filter((a) => a.status === "interviewing" || a.status === "offer" ||
    (a.status === "applied" && a.lastEvidenceAt !== null && asOf - Date.parse(a.lastEvidenceAt.slice(0, 10)) <= PROJECT_RECENT_DAYS * 86_400_000));
  const activeProjects: ActiveProjectProposal[] = engaged.map((a) => {
    const name = jobLabel(a);
    return { name, opportunityKey: a.key, employer: a.employer, title: a.title, reqId: a.reqId, status: a.status,
      evidence: a.events.slice(-6).map((e) => `${e.kind} ${e.at.slice(0, 10)}: ${e.subject}`), evidenceIds: a.events.map((e) => e.recordId),
      lastContact: a.lastEvidenceAt, contact: a.contact, proposedFollowup: a.followup, followupDue: a.followupDue,
      existingProject: projKeys.get(name.toLowerCase()) ?? null };
  });
  const pipelineOnly = interp.active.filter((a) => !engaged.includes(a)).map((a) => `${jobLabel(a)}: ${a.status}, last evidence ${a.lastEvidenceAt?.slice(0, 10) ?? "?"}`);
  const byStatus: Record<string, number> = {};
  for (const o of opportunities) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  return {
    area: "Career", objective: { proposed: CAREER_OBJECTIVE, needsConfirmation: true },
    source: { sheet: snapshot.sheet.name ?? null, sheetId: snapshot.sheet.id ?? null, account: snapshot.sheet.account ?? null, rows: sheet.rows.length, dropped: sheet.dropped, duplicates: sheet.duplicates, duplicateRows: sheet.duplicateRows },
    pipeline: { total: opportunities.length, byStatus, shortlist: interp.pipeline.shortlist },
    employers: interp.employers.map((e) => ({ key: e.key, name: e.name, aliases: e.aliases, party: e.party, partyReason: e.partyReason, jobs: e.opportunityKeys.length })),
    activeProjects, pipelineOnly,
    closed: interp.closed.map((c) => ({ job: jobLabel(c), status: c.status, lastEvidence: c.lastEvidenceAt, evidenceIds: c.events.map((e) => e.recordId) })),
    unassigned: interp.unassigned.map((u) => ({ employer: u.employer, recordId: u.recordId, at: u.at, kind: u.kind, reason: u.reason })),
    conflicts: interp.conflicts, opportunities,
  };
}
export const CAREER_OBJECTIVE = "Secure a strong Financial / Pricing Analyst role";

/** What Julian reads (bounded size): the decision-relevant parts of a proposal; the full job list stays in the payload. */
export function compactProposal(code: number, s: Omit<BootstrapPayload, "opportunities">) {
  return { proposalCode: code, objective: s.objective, provenance: s.provenance, applicable: s.applicable,
    jobs: { total: s.pipeline.total, byStatus: s.pipeline.byStatus }, employers: s.employers?.length ?? 0,
    recruitersOrJobBoards: (s.employers ?? []).filter((e) => e.party !== "employer").map((e) => `${e.name} (${e.party}: ${e.partyReason})`),
    activeProjects: s.activeProjects.map((a) => ({ project: a.name, status: a.status, last: a.lastContact?.slice(0, 10) ?? null, contact: a.contact, followup: a.proposedFollowup })),
    pipelineOnly: s.pipelineOnly, closed: (s.closed ?? []).map((c) => `${c.job}: ${c.status} (${c.lastEvidence?.slice(0, 10) ?? "?"})`),
    unassigned: s.unassigned, duplicatesMerged: s.source.duplicateRows, conflicts: s.conflicts.map((c) => c.slice(0, 600)), shortlist: s.pipeline.shortlist,
    delta: s.delta ? { sameInput: s.delta.sameInput, sameOpportunitySet: s.delta.sameOpportunitySet, oppAdded: s.delta.oppAdded.slice(0, 20), oppRemoved: s.delta.oppRemoved.slice(0, 20), statusChanged: s.delta.statusChanged.slice(0, 20), unexplained: s.delta.unexplained } : null };
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

/**
 * Re-interpret an existing proposal's FROZEN inputs with the current interpreter and stage a NEW proposal (no acquisition,
 * no Career writes). The superseded proposal is marked discarded. Same snapshot + same as-of ⇒ same result.
 */
export async function reinterpretProposal(pool: pg.Pool, code: number) {
  const r = (await pool.query(`SELECT p.id, p.status, p.payload, p.snapshot_id, p.acquisition_id, s.payload AS snapshot, s.digest FROM bootstrap_proposal p JOIN evidence_snapshot s ON s.id = p.snapshot_id WHERE p.code = $1`, [code])).rows[0];
  if (!r) return { error: `No bootstrap proposal ${code} with a frozen snapshot.` };
  const old = r.payload as BootstrapPayload; const snapshot = r.snapshot as CareerSnapshot;
  const asOf = old.provenance?.asOf ?? snapshot.acquiredAt.slice(0, 10);
  const interp = interpretCareer(snapshot, { asOf });
  const projects = (await pool.query(`SELECT name FROM project WHERE archived_at IS NULL AND NOT is_unassigned_holding`)).rows.map((x) => String(x.name));
  const why = snapshot.completeness.complete ? [] : [`incomplete snapshot: ${snapshot.completeness.problems.join("; ")}`];
  const provenance = { ...(old.provenance ?? {} as NonNullable<BootstrapPayload["provenance"]>), snapshotId: r.snapshot_id, acquisitionId: r.acquisition_id, snapshotDigest: r.digest,
    interpretationDigest: interpretationDigest(interp), opportunitySetDigest: opportunitySetDigest(interp), interpreterVersion: INTERPRETER_VERSION, asOf: interp.asOf, reinterpretedFrom: code };
  const payload: BootstrapPayload = { ...buildCareerPayload(interp, snapshot, projects), provenance, applicable: { ok: why.length === 0, why }, delta: null };
  const ins = await pool.query(`INSERT INTO bootstrap_proposal (area, payload, snapshot_id, acquisition_id, snapshot_digest, interpretation_digest, opportunity_set_digest, interpreter_version)
    VALUES ('Career', $1::jsonb, $2, $3, $4, $5, $6, $7) RETURNING code`, [JSON.stringify(payload), r.snapshot_id, r.acquisition_id, r.digest, provenance.interpretationDigest, provenance.opportunitySetDigest, INTERPRETER_VERSION]);
  if (r.status === "pending") await pool.query(`UPDATE bootstrap_proposal SET status = 'discarded' WHERE id = $1`, [r.id]);
  const { opportunities: _o, ...summary } = payload; void _o;
  return { code: Number(ins.rows[0].code), supersedes: code, summary, interp };
}

/**
 * Apply an approved proposal (the ONLY writer of Career state; never called by propose/replay/stability). Idempotent.
 * Employers are shared entities; each JOB opportunity is matched by ANY of its alias keys, keeps its own status, event
 * history (opportunity_event), evidence, contact, dates, source ids, project and follow-up. Nothing is ever deleted.
 */
export async function applyBootstrap(pool: pg.Pool, code: number, opts: { objective?: string | null; skipFollowups?: boolean } = {}) {
  const p = (await pool.query(`SELECT id, status, payload FROM bootstrap_proposal WHERE code = $1`, [code])).rows[0];
  if (!p) return { error: `No bootstrap proposal ${code}.` };
  if (p.status !== "pending") return { error: `Bootstrap proposal ${code} is already ${p.status}.` };
  const pl = p.payload as BootstrapPayload;
  if (pl.applicable && !pl.applicable.ok) return { error: `Bootstrap proposal ${code} is not applicable: ${pl.applicable.why.join("; ")}` };
  if (!pl.employers) return { error: `Bootstrap proposal ${code} uses the retired employer-level model; create a new proposal.` };
  const area = await ensureArea(pool, pl.area);
  return withTransaction(pool, async (tx) => {
    const objName = opts.objective ?? pl.objective.proposed;
    const ob = await tx.query(`SELECT id FROM objective WHERE area_id = $1 AND lower(name) = lower($2)`, [area.id, objName]);
    const objectiveId: string = ob.rows[0]?.id ?? (await tx.query(`INSERT INTO objective (area_id, name) VALUES ($1, $2) RETURNING id`, [area.id, objName])).rows[0].id;
    const empId = new Map<string, string>();
    for (const e of pl.employers!) {
      const r = await tx.query(`INSERT INTO employer (key, name, aliases, party, details) VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (key) DO UPDATE SET aliases = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(employer.aliases || EXCLUDED.aliases) x), party = EXCLUDED.party, updated_at = now() RETURNING id`,
        [e.key, e.name, e.aliases, e.party, JSON.stringify({ partyReason: e.partyReason })]);
      empId.set(e.key, r.rows[0].id);
    }
    const oppId = new Map<string, string>();
    let inserted = 0, updated = 0, events = 0;
    for (const o of pl.opportunities) {
      const aliases = [...new Set([o.dedupe, ...o.aliasKeys])];
      const details = JSON.stringify({ folder: o.folder, sheetUpdatedAt: o.updatedAt, statusSource: o.statusSource, anomalies: o.anomalies });
      let employerId = empId.get(o.employerKey) ?? null;
      if (!employerId) {
        const r = await tx.query(`INSERT INTO employer (key, name, aliases) VALUES ($1, $2, ARRAY[$1]) ON CONFLICT (key) DO UPDATE SET updated_at = now() RETURNING id`, [o.employerKey, o.org]);
        employerId = r.rows[0].id; empId.set(o.employerKey, employerId!);
      }
      // Exact identity first; an alias match must be unambiguous (two candidates = never merge, insert a new job instead).
      const ex0 = await tx.query(`SELECT id FROM opportunity WHERE kind = 'job' AND archived_at IS NULL AND dedupe_key = $1`, [o.dedupe]);
      const exA = ex0.rows[0] ? ex0 : await tx.query(`SELECT id FROM opportunity WHERE kind = 'job' AND archived_at IS NULL AND (dedupe_key = ANY($1::text[]) OR alias_keys && $1::text[]) AND NOT (id = ANY($2::uuid[]))`, [aliases, [...oppId.values()]]);
      const ex = { rows: exA.rows.length === 1 ? exA.rows : [] };
      let id: string;
      if (ex.rows[0]) {
        id = ex.rows[0].id; updated++;
        await tx.query(`UPDATE opportunity SET status = $2, fit_score = COALESCE($3, fit_score), employer_id = $4, requisition_id = COALESCE($5, requisition_id), identity_basis = $6,
          alias_keys = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(alias_keys || $7::text[]) x), source_ids = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(source_ids || $8::text[]) x),
          contact = COALESCE($9, contact), first_evidence_at = COALESCE($10, first_evidence_at), last_evidence_at = COALESCE($11, last_evidence_at), applied_at = COALESCE(applied_at, $12),
          details = details || $13::jsonb, updated_at = now() WHERE id = $1`,
          [id, o.status, o.fitScore, employerId, o.reqId, o.identityBasis, aliases, o.sourceIds, o.contact, o.firstEvidenceAt, o.lastEvidenceAt, o.appliedAt, details]);
      } else {
        inserted++;
        id = (await tx.query(
          `INSERT INTO opportunity (kind, area_id, org, title, url, location, work_mode, salary, eligibility, status, fit_score, fit_notes, resume_ref, next_action, next_action_at, source, dedupe_key, details,
             employer_id, requisition_id, identity_basis, alias_keys, source_ids, contact, first_evidence_at, last_evidence_at, applied_at)
           VALUES ('job', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23, $24, $25, $26) RETURNING id`,
          [area.id, o.org, o.title, o.url, o.location, o.workMode, o.salary, o.eligibility, o.status, o.fitScore, o.fitNotes, o.resume, o.nextAction,
           o.nextActionAt && !Number.isNaN(Date.parse(o.nextActionAt)) ? o.nextActionAt : null, o.statusSource === "evidence" ? "gmail" : `career_copilot:${o.sourceId}`, o.dedupe, details,
           employerId, o.reqId, o.identityBasis, aliases, o.sourceIds, o.contact, o.firstEvidenceAt, o.lastEvidenceAt, o.appliedAt])).rows[0].id;
      }
      oppId.set(o.dedupe, id);
      for (const e of o.events) {
        const r = await tx.query(`INSERT INTO opportunity_event (opportunity_id, at, kind, source, source_id, summary, transition) VALUES ($1, $2, $3, 'gmail', $4, $5, $6) ON CONFLICT DO NOTHING`,
          [id, e.at, e.kind, e.sourceId, e.subject, e.transition]);
        events += r.rowCount ?? 0;
      }
    }
    const created: string[] = [];
    for (const a of pl.activeProjects) {
      const ex = await tx.query(`SELECT id FROM project WHERE archived_at IS NULL AND lower(name) = lower($1) LIMIT 1`, [a.existingProject ?? a.name]);
      let pid: string;
      if (ex.rows[0]) pid = ex.rows[0].id;
      else { pid = (await tx.query(`INSERT INTO project (name, description, last_activity_at) VALUES ($1, $2, now()) RETURNING id`, [a.name, `Job opportunity (${a.status}; ${a.evidence.slice(-3).join("; ")})`.slice(0, 500)])).rows[0].id; created.push(a.name); }
      await tx.query(`UPDATE project SET area_id = $2, objective_id = $3, updated_at = now() WHERE id = $1`, [pid, area.id, objectiveId]);
      const oid = oppId.get(a.opportunityKey);
      if (oid) await tx.query(`UPDATE opportunity SET project_id = $2, contact = COALESCE(contact, $3) WHERE id = $1`, [oid, pid, a.contact]);
      if (a.proposedFollowup && !opts.skipFollowups) {
        const dup = await tx.query(`SELECT 1 FROM followup WHERE project_id = $1 AND state IN ('open','waiting','overdue')`, [pid]);
        if (!dup.rowCount) await tx.query(`INSERT INTO followup (summary, counterparty, state, due_at, last_action_at, area_id, project_id) VALUES ($1, $2, 'waiting', now() + interval '3 days', $3, $4, $5)`,
          [a.proposedFollowup, a.contact ?? a.employer, a.lastContact ?? new Date().toISOString(), area.id, pid]);
      }
    }
    await tx.query(`UPDATE bootstrap_proposal SET status = 'applied', applied_at = now() WHERE id = $1`, [p.id]);
    await appendEvent(tx, { actor: "julian", action: "bootstrap_applied", entityType: "area", entityId: area.id, after: { code, inserted, updated, events, projectsCreated: created, snapshot: pl.provenance?.snapshotDigest ?? null } });
    return { area: area.name, objective: objName, employers: pl.employers!.length, opportunities: pl.opportunities.length, inserted, updated, events, activeProjects: pl.activeProjects.map((a) => a.name), projectsCreated: created };
  });
}
