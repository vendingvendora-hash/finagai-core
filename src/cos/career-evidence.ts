/**
 * ADR-080 — Career bootstrap: deterministic, reproducible evidence pipeline.
 *
 * Live failure (2026-10-09, proposals #1–#3 within 18 min): Immuta (evidence from 10/05) and Transurban (10/02)
 * appeared and disappeared between runs although all their evidence pre-dated every run. Root causes:
 *  1. Acquisition was a RANKED TOP-N retrieval built for chat (Gmail maxResults=25 newest per term, a relevance score
 *     that pushes LinkedIn/no-reply senders down, then top 8): every newly arrived application email displaced
 *     older evidence, so the evidence set depended on what had arrived since, not on what exists.
 *  2. Failures were swallowed (`.catch(() => [])`; the per-account fan-out kept only successes; a failed profile
 *     probe relabelled an account): a 429/timeout silently removed a source.
 *  3. The interpretation code changed between runs (hotfixes 3 and 4) and the proposal recorded neither its inputs
 *     nor its code version, so no difference could be attributed to anything.
 *  4. Org extraction was one fragile subject regex; LinkedIn/ATS notice formats were partly unparsed ("Senior").
 *  5. (found while building this) Gmail snippets are HTML-escaped ("we&#39;ve made the decision"), so the Immuta
 *     rejection could never be recognised, and the acquisition window rolled with the clock.
 *
 * Design: ACQUIRE (exhaustive, paginated, retried, every outcome recorded; previously seen evidence re-verified by id)
 * → frozen SNAPSHOT (content digest) → INTERPRET (pure function of snapshot + as-of date: no model, no clock, no I/O)
 * → proposal carrying both digests, the interpreter version, per-record and per-org traces, and a record-level
 * delta against the previous snapshot in which every opportunity change must be explained by specific records.
 */
import { createHash } from "node:crypto";
import type { GmailRecord, CalendarRecord } from "../google/client.js";
import { extractSheet, normOrg, type SheetOpportunity } from "./bootstrap.js";

export const INTERPRETER_VERSION = "career-interpret-3";
/** Fixed acquisition lower bound (NOT rolling with the clock, so a record can't age out between two runs). */
export const CAREER_EPOCH = "2026/06/01";
export const CALENDAR_AHEAD_DAYS = 120;

/** Fixed, recorded acquisition queries — no ranking, no top-N. Body phrases included: ATS mails often carry the
 *  application wording only in the body ("Pricing Analyst - Resource Innovations"). */
export const CAREER_QUERIES: Record<string, string> = {
  applications: `(subject:application OR subject:applying OR subject:applied OR "thanks for applying" OR "thank you for applying" OR "thank you for your applying" OR "thank you for your interest" OR "your application")`,
  interviews: `subject:(interview OR "phone screen" OR screening OR "next steps")`,
  outcomes: `("regret to inform" OR "not to move forward" OR "not moving forward" OR "unable to move forward" OR "not be proceeding" OR "move forward with other" OR "move forward with another" OR "made the decision" OR "position has been filled" OR "no longer under consideration" OR "not been selected" OR "offer letter" OR "pleased to offer")`,
};
export const CALENDAR_QUERIES = ["interview", "screen"];
export const GMAIL_MAX = 2000;

export interface GmailAcquisition { key: string; query: string; account: string; ok: boolean; error?: string; pages: number; truncated: boolean; ids: number; vanished: string[]; records: GmailRecord[] }
export interface CarryForward { account: string; fromSnapshot: string; requested: number; ok: boolean; error?: string; records: GmailRecord[]; missing: Array<{ id: string; reason: string }> }
export interface CalendarAcquisition { query: string; account: string; ok: boolean; error?: string; pages: number; records: CalendarRecord[] }
export interface CareerSnapshot {
  version: 2; acquiredAt: string; interpreterVersion: string;
  window: { gmailAfter: string; calendarFrom: string; calendarTo: string };
  sheet: { ok: boolean; error?: string; id?: string; name?: string; account?: string; modified?: string; modifiedAfter?: string; mutatedDuringRun?: boolean;
    sha256?: string; csv?: string; candidates?: Array<{ id: string; name: string; modified: string; account?: string }>; pinnedFrom?: string | null; accountErrors?: string[] };
  gmail: GmailAcquisition[];
  carryForward: CarryForward[];
  calendar: CalendarAcquisition[];
  completeness: { complete: boolean; problems: string[]; searchMisses: number };
}

type SheetHit = { id?: string; name: string; csv: string; modified: string; account?: string; candidates?: Array<{ id: string; name: string; modified: string; account?: string }>; errors?: string[] };
export interface CareerSources {
  sheetCsv?(title: string, preferId?: string): Promise<SheetHit | null>;
  gmailEnumerate?(q: string, opts?: { maxMessages?: number }): Promise<Array<{ account: string; ok: boolean; error?: string; records: GmailRecord[]; pages: number; truncated: boolean; ids: number; vanished?: string[] }>>;
  gmailMetadata?(account: string, ids: string[]): Promise<{ records: GmailRecord[]; missing: Array<{ id: string; reason: string }> }>;
  calendarEnumerate?(q: string, timeMin: string, timeMax: string): Promise<Array<{ account: string; ok: boolean; error?: string; records: CalendarRecord[]; pages: number }>>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
/** Canonical JSON (sorted keys) so digests depend on content, never on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// ---------------------------------------------------------------------------------------------------------------
// ACQUIRE

/**
 * Exhaustive, recorded, no silent drops. `prev` (the last stored snapshot) pins the sheet file and lets every
 * previously seen Gmail record be RE-VERIFIED by id when a search does not return it: evidence can only leave the
 * snapshot if it was deleted/trashed at the source (recorded with the reason), never because of search behaviour.
 */
export async function acquireCareerSnapshot(src: CareerSources, sheetTitle: string, now = new Date(), prev?: { digest: string; snapshot: CareerSnapshot } | null): Promise<CareerSnapshot> {
  const day = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window = { gmailAfter: CAREER_EPOCH, calendarFrom: `${CAREER_EPOCH.replace(/\//g, "-")}T00:00:00.000Z`, calendarTo: new Date(today + CALENDAR_AHEAD_DAYS * day).toISOString() };
  const problems: string[] = [];
  const pinned = prev?.snapshot.sheet.id ?? null;
  let sheet: CareerSnapshot["sheet"] = { ok: false, error: "no sheet source" };
  if (src.sheetCsv) {
    try {
      const s = await src.sheetCsv(sheetTitle, pinned ?? undefined);
      sheet = s ? { ok: true, name: s.name, modified: s.modified, sha256: sha(s.csv), csv: s.csv, pinnedFrom: pinned, ...(s.id ? { id: s.id } : {}), ...(s.account ? { account: s.account } : {}),
        ...(s.candidates ? { candidates: s.candidates } : {}), ...(s.errors?.length ? { accountErrors: s.errors } : {}) } : { ok: false, error: "sheet not found" };
      if (s && pinned && s.id && s.id !== pinned) problems.push(`sheet: pinned file ${pinned} no longer available; using ${s.id}`);
      if (s?.errors?.length) problems.push(`sheet lookup errors: ${s.errors.join("; ")}`);
    } catch (e) { sheet = { ok: false, error: errText(e) }; }
  }
  if (!sheet.ok) problems.push(`sheet: ${sheet.error}`);

  const gmail: GmailAcquisition[] = [];
  for (const [key, base] of Object.entries(CAREER_QUERIES)) {
    const q = `after:${window.gmailAfter} ${base}`;
    let per: Awaited<ReturnType<NonNullable<CareerSources["gmailEnumerate"]>>> = [];
    if (src.gmailEnumerate) {
      try { per = await src.gmailEnumerate(q, { maxMessages: GMAIL_MAX }); }
      catch (e) { problems.push(`gmail ${key}: ${errText(e)}`); }
    } else problems.push("gmail: no source");
    for (const p of per) {
      gmail.push({ key, query: q, account: p.account, ok: p.ok, ...(p.error ? { error: p.error } : {}), pages: p.pages, truncated: p.truncated, ids: p.ids, vanished: [...(p.vanished ?? [])].sort(), records: p.records });
      if (!p.ok) problems.push(`gmail ${key} @ ${p.account}: ${p.error}`);
      if (p.truncated) problems.push(`gmail ${key} @ ${p.account}: truncated at ${p.records.length} messages`);
    }
  }

  // Carry-forward: every Gmail record of the previous snapshot that no search returned now is re-fetched by id.
  const carryForward: CarryForward[] = [];
  let searchMisses = 0;
  if (prev) {
    const have = new Set(gmail.flatMap((g) => g.records.map((r) => `${g.account}|${r.id}`)));
    const want = new Map<string, Set<string>>();
    for (const g of [...prev.snapshot.gmail, ...(prev.snapshot.carryForward ?? [])]) for (const r of g.records)
      if (!have.has(`${g.account}|${r.id}`)) want.set(g.account, (want.get(g.account) ?? new Set()).add(r.id));
    for (const account of [...want.keys()].sort()) {
      const ids = [...want.get(account)!].sort();
      searchMisses += ids.length;
      if (!src.gmailMetadata) { carryForward.push({ account, fromSnapshot: prev.digest, requested: ids.length, ok: false, error: "no re-verification source", records: [], missing: [] }); problems.push(`carry-forward @ ${account}: no re-verification source`); continue; }
      try { const r = await src.gmailMetadata(account, ids); carryForward.push({ account, fromSnapshot: prev.digest, requested: ids.length, ok: true, records: r.records, missing: r.missing }); }
      catch (e) { carryForward.push({ account, fromSnapshot: prev.digest, requested: ids.length, ok: false, error: errText(e), records: [], missing: [] }); problems.push(`carry-forward @ ${account}: ${errText(e)}`); }
    }
  }

  const calendar: CalendarAcquisition[] = [];
  for (const q of CALENDAR_QUERIES) {
    let per: Awaited<ReturnType<NonNullable<CareerSources["calendarEnumerate"]>>> = [];
    if (src.calendarEnumerate) {
      try { per = await src.calendarEnumerate(q, window.calendarFrom, window.calendarTo); }
      catch (e) { problems.push(`calendar "${q}": ${errText(e)}`); }
    }
    for (const p of per) {
      calendar.push({ query: q, account: p.account, ok: p.ok, ...(p.error ? { error: p.error } : {}), pages: p.pages, records: p.records });
      if (!p.ok) problems.push(`calendar "${q}" @ ${p.account}: ${p.error}`);
    }
  }
  // Mutation check: the sheet is re-read after acquisition; a change during the run is recorded (snapshot incomplete).
  if (sheet.ok && src.sheetCsv) {
    try { const again = await src.sheetCsv(sheetTitle, sheet.id); if (again) { sheet.modifiedAfter = again.modified; sheet.mutatedDuringRun = again.modified !== sheet.modified || sha(again.csv) !== sheet.sha256; } }
    catch (e) { problems.push(`sheet re-read: ${errText(e)}`); }
    if (sheet.mutatedDuringRun) problems.push("sheet changed during acquisition");
  }
  return { version: 2, acquiredAt: now.toISOString(), interpreterVersion: INTERPRETER_VERSION, window, sheet, gmail, carryForward, calendar,
    completeness: { complete: problems.length === 0, problems, searchMisses } };
}

/** Digest of the INPUT content: the evidence records + sheet bytes + fixed window. Acquisition time, paging and how
 *  a record was found (search vs carry-forward) are excluded, so the same evidence always has the same digest. */
export function snapshotDigest(s: CareerSnapshot): string {
  const recs = evidenceRecords(s).map((r) => ({ id: r.id, source: r.source, account: r.account, at: r.at, subject: r.subject, from: r.from, snippet: r.snippet, body: r.body, templates: r.templates }));
  return sha(canonical({ gmailAfter: s.window.gmailAfter, sheet: s.sheet.sha256 ?? null, recs, complete: s.completeness.complete })).slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------------
// INTERPRET — pure. Same snapshot (+ same as-of date) ⇒ byte-identical output, in any record order.

export interface EvidenceRecord { id: string; source: "gmail" | "calendar"; account: string; at: string; subject: string; from: string; snippet: string; body: string; templates: string[]; queries: string[] }

/** All distinct evidence records, deduped by (source, account, id), in a total order independent of acquisition order. */
export function evidenceRecords(s: CareerSnapshot): EvidenceRecord[] {
  const m = new Map<string, EvidenceRecord>();
  const addGmail = (account: string, r: GmailRecord, via: string) => {
    const k = `gmail|${account}|${r.id}`;
    const ex = m.get(k);
    if (ex) { if (!ex.queries.includes(via)) ex.queries.push(via); return; }
    m.set(k, { id: r.id, source: "gmail", account, at: new Date(r.internalDate).toISOString(), subject: r.subject, from: r.from, snippet: r.snippet, body: r.body ?? "", templates: [...(r.templates ?? [])].sort(), queries: [via] });
  };
  for (const g of s.gmail) for (const r of g.records) addGmail(g.account, r, g.key);
  for (const c of s.carryForward ?? []) for (const r of c.records) addGmail(c.account, r, "carry-forward");
  for (const c of s.calendar) for (const r of c.records) {
    const k = `calendar|${c.account}|${r.id}`;
    const ex = m.get(k);
    if (ex) { if (!ex.queries.includes(`cal:${c.query}`)) ex.queries.push(`cal:${c.query}`); continue; }
    const at = /^\d{4}-\d{2}-\d{2}$/.test(r.start) ? `${r.start}T00:00:00.000Z` : new Date(r.start).toISOString();
    m.set(k, { id: r.id, source: "calendar", account: c.account, at, subject: r.summary, from: "", snippet: "", body: "", templates: [], queries: [`cal:${c.query}`] });
  }
  const out = [...m.values()];
  for (const r of out) r.queries.sort();
  return out.sort((a, b) => cmp(a.at, b.at) || cmp(a.source, b.source) || cmp(a.account, b.account) || cmp(a.id, b.id));
}
/** Locale-independent comparison (localeCompare can differ between runtimes/ICU builds). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Gmail snippets (and some subjects) are HTML-escaped: "we&#39;ve made the decision", "FP&amp;A". */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&"; if (l === "lt") return "<"; if (l === "gt") return ">"; if (l === "quot") return '"'; if (l === "apos") return "'"; if (l === "nbsp") return " ";
    const n = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : _;
  }).replace(/[͏​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

export type EvidenceKind = "application" | "viewed" | "screen" | "interview" | "rejection" | "offer";
const ORG = String.raw`([A-Z0-9][\w&.,'’-]*(?:\s+(?:[A-Z0-9&][\w&.,'’-]*|of|and|for|the|de|y)){0,5})`;
const TITLE_WORDS = /^(senior|sr\.?|junior|jr\.?|lead|principal|staff|associate|assistant|financial|finance|pricing|accounting|business|data|cost|budget|program|analyst|manager|director|specialist|coordinator|consultant|fp&a|fp|structured|entry)\b/i;
/** Strong outcome wording only — safe on bodies (bare "unfortunately" only counts in subject/snippet: confirmations say
 *  "unfortunately we can't reply to everyone"). Live examples: JHU, Cvent ("Thank You For Applying" — a rejection), Accenture. */
const REJECT = /\b(regret to inform|not (?:to )?(?:move|moving) forward with (?:your|you)|decided not to (?:move forward|proceed|pursue)|(?:will|are) not be (?:moving forward|proceeding)|not be proceeding|unable to move forward|(?:decided|chosen|elected|decision) to (?:move forward|proceed|pursue|go) with (?:other|another) (?:candidate|applicant)|move forward with (?:other|another) (?:candidate|applicant)|we(?:'|’)?ve made the decision|we have made the decision|no longer (?:being )?(?:considered|under consideration)|position (?:has been|is now) (?:filled|closed)|(?:have|has) not been selected|not selected (?:to|for)|pursue other candidates)/i;
const OFFER = /\b(offer letter|pleased to (?:offer|extend)|extend(?:ing)? (?:you )?an offer|job offer|offer of employment)\b/i;
const NOT_ORG = /^(julian|your|you|the|a|an|us|me|our|linkedin|indeed|workable|lever|greenhouse)$/i;
const ATS_OR_JOBS = /(jobs-noreply@linkedin|lever\.co|greenhouse|workablemail|workable|ashbyhq|smartrecruiters|icims|myworkday|jobvite|bamboohr|paylocity|ultipro|taleo|successfactors|jazzhr|breezy|recruitee|teamtailor|rippling|dayforce|paycom)/i;
const JOB_CONTEXT = /\b(position|role|job|analyst|candidate|candidacy|hiring|recruit\w*|talent|resume|interview\w*|opening|requisition|employment)\b/i;
const GENERIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|yahoo|ouryahoo|icloud|aol|protonmail|glassdoor|linkedin|lever|greenhouse|greenhouse-jobs|workable|workablemail|ashbyhq|smartrecruiters|icims|myworkday|workday|jobvite|bamboohr|indeed|ziprecruiter|otter|zoom|google|calendly|paylocity|adp|ultipro|taleo|successfactors|jazzhr|breezy|recruitee|teamtailor|rippling|dayforce|paycom|correounivalle)\.$/i;
const NOISE: Array<{ re: RegExp; field: "from" | "subject"; why: string }> = [
  { re: /newsletters?-noreply|messages-noreply|jobs-listings|jobalerts?|job-alerts|digest|notifications?-noreply/i, field: "from", why: "newsletter / job-alert sender, not an application record" },
  { re: /\b(see hiring trends|jobs? (?:for you|alert)|new .*jobs? update|recommended jobs?|is hiring|top applicant|people also viewed|job recommendations?|apply now|apply to your saved jobs|view your application updates|hired roles near you)\b/i, field: "subject", why: "job-board marketing / digest, not an application record" },
];

export interface RecordTrace { recordId: string; source: string; account: string; at: string; subject: string; queries: string[]; stage: "excluded" | "unclassified" | "unparsed" | "candidate"; rule?: string; kind?: EvidenceKind; org?: string; orgKey?: string; title?: string; reason: string }

function cleanOrg(s: string): string {
  let o = s.split(/[.,;:!?](?:\s|$)/)[0]!.replace(/[.,;:!'’-]+$/, "").trim();
  for (let prev = ""; prev !== o;) { prev = o; o = o.replace(/\s+(?:position|role|job|team|careers?|inc\.?|llc|ltd|of|and|for|the|de|y)$/i, "").trim(); }
  return o;
}
const validOrg = (o: string) => !!o && o.length > 1 && !TITLE_WORDS.test(o) && !NOT_ORG.test(o);

/** Classify one record and extract its organization with the FIRST matching deterministic rule. */
export function classifyRecord(r: EvidenceRecord, knownOrgKeys: Set<string>): RecordTrace {
  const subject = decodeEntities(r.subject), snippet = decodeEntities(r.snippet);
  const base = { recordId: r.id, source: r.source, account: r.account, at: r.at, subject: subject.slice(0, 160), queries: r.queries };
  for (const n of NOISE) if (n.re.test(n.field === "from" ? r.from : subject)) return { ...base, stage: "excluded", reason: n.why };
  const subj = subject.replace(/^(?:(?:re|fwd?|fw|canceled|cancelled|updated invitation|invitation|accepted|declined):\s*)+/i, "").trim();
  const body = decodeEntities(r.body);
  const head = `${subj} ${snippet}`;                // subject + snippet
  const text = `${head} ${body}`;                   // + body text (URLs removed)
  let kind: EvidenceKind | null = null; let via = "";
  if (r.templates.some((t) => /application_rejected/.test(t))) { kind = "rejection"; via = `LinkedIn template ${r.templates.find((t) => /application_rejected/.test(t))}`; }
  else if (OFFER.test(text)) { kind = "offer"; via = "offer wording"; }
  else if (REJECT.test(text) || /\bunfortunately\b/i.test(head)) { kind = "rejection"; via = REJECT.test(head) || /\bunfortunately\b/i.test(head) ? "rejection wording (subject/snippet)" : "rejection wording (body)"; }
  else if (/\b(phone screen|screening call|screening interview)\b/i.test(subj)) kind = "screen";
  else if (/\binterview\b/i.test(subj) && !/\b(how to|tips|prepare for your|ace your)\b/i.test(subj)) kind = "interview";
  else if (/application (?:for .{3,120}? )?was viewed/i.test(subj) || r.templates.some((t) => /application_viewed/.test(t))) kind = "viewed";
  else if (/\b(application|applying|applied|thanks for applying|thank you for applying|thank you for your interest)\b/i.test(head)) kind = "application";
  if (!kind) return { ...base, stage: "unclassified", reason: "no application/interview/outcome signal" };
  if (!ATS_OR_JOBS.test(r.from) && !JOB_CONTEXT.test(head) && r.source === "gmail")
    return { ...base, stage: "unclassified", kind, reason: `${kind} wording but no job context (not an ATS/LinkedIn sender, no role/position/hiring words)` };

  // [name, pattern, org group, title group, where: s=subject n=snippet b=body]. Bodies are only searched by rules that
  // cannot be fooled by the job recommendations LinkedIn appends ("View similar jobs … at McKesson").
  const rules: Array<[string, RegExp, number, number, string]> = [
    ["linkedin:application_to_title_at_org", new RegExp(String.raw`[Aa]pplication (?:to|for) (.{3,120}?) at ${ORG}`), 2, 1, "sn"],
    ["notice:application_sent_viewed_received", new RegExp(String.raw`[Aa]pplication (?:for (.{3,120}?) )?(?:was )?(?:sent to|viewed by|received by|submitted to) ${ORG}`), 2, 1, "sn"],
    ["linkedin:update_from_org", new RegExp(String.raw`^Your update from ${ORG}`), 1, 0, "b"],
    ["ats:thanks_for_applying_to_org", new RegExp(String.raw`(?:[Tt]hanks|[Tt]hank [Yy]ou) [Ff]or (?:[Aa]pplying|[Yy]our application|[Yy]our interest|[Yy]our applying|taking the time to apply)(?: [Tt]o| [Aa]t| [Ii]n| [Ww]ith| [Ff]or)(?: the)?(?: (.{3,80}?) (?:position|role|job|opening)(?: at| with))? ${ORG}`), 2, 1, "snb"],
    ["subject:title_at_sign_org", new RegExp(String.raw`(?:^|-\s)([^@-]{3,80}?)\s*@ ${ORG}\s*$`), 2, 1, "s"],
    ["subject:interview_or_screen_with_org", new RegExp(String.raw`(?:[Ii]nterview|[Pp]hone [Ss]creen|[Ss]creening(?: [Cc]all)?)(?: [Ii]nvitation)? (?:with|at|for) ${ORG}`), 1, 0, "s"],
  ];
  const fields: Record<string, string> = { s: subj, n: snippet, b: body };
  for (const [name, re, g, tg, where] of rules) {
    for (const w of where) {
      const m = re.exec(fields[w]!);
      if (!m) continue;
      const org = cleanOrg(m[g] ?? "");
      if (!validOrg(org)) continue;
      const title = tg && m[tg] ? m[tg]!.trim().replace(/^the\s+/i, "") : undefined;
      return { ...base, stage: "candidate", rule: name, kind, org, orgKey: normOrg(org), ...(title && !/^(julian|your)/i.test(title) ? { title } : {}), reason: `${kind}${via ? ` (${via})` : ""}; org by ${name}${w === "n" ? " (snippet)" : w === "b" ? " (body)" : ""}` };
    }
  }
  // "Title - Org" / "Org - Title": only when one side is an organization already known from the sheet or from an
  // unambiguous record (live: "Indeed Application: Senior Finance Analyst - Commercial Performance & Investment Review"
  // must not invent the employer "Commercial Performance & Investment Review").
  const dash = /^(.{2,90}?)\s+[-–|]\s+(.{2,90})$/.exec(subj);
  if (dash) {
    const [a, b] = [cleanOrg(dash[1]!), cleanOrg(dash[2]!)];
    const pick = knownOrgKeys.has(normOrg(b)) ? b : knownOrgKeys.has(normOrg(a)) ? a : null;
    if (pick && validOrg(pick)) return { ...base, stage: "candidate", rule: "subject:title_dash_known_org", kind, org: pick, orgKey: normOrg(pick), title: pick === b ? a : b, reason: `${kind}${via ? ` (${via})` : ""}; org by subject:title_dash_known_org` };
  }
  // Sender domain of a real company (not a mail provider or ATS).
  const dom = /@(?:[a-z0-9-]+\.)*?([a-z0-9-]+)\.[a-z]{2,6}(?:\.[a-z]{2})?>?\s*$/i.exec(r.from);
  if (dom && !GENERIC_DOMAINS.test(`${dom[1]}.`) && dom[1]!.length > 2) {
    const org = dom[1]!.charAt(0).toUpperCase() + dom[1]!.slice(1);
    return { ...base, stage: "candidate", rule: "sender_domain", kind, org, orgKey: normOrg(org), reason: `${kind}${via ? ` (${via})` : ""}; org by sender domain ${dom[1]}` };
  }
  return { ...base, stage: "unparsed", kind, reason: `${kind}${via ? ` (${via})` : ""} but no organization could be extracted by any rule` };
}

/**
 * Deterministic alias resolution: "altarum" and "altarum institute" are one organization when one key's tokens are a
 * prefix of the other's (first token ≥ 4 chars). The canonical key is the shortest; ALL aliases are kept so stored
 * opportunities match whichever spelling they were created under (stable identity).
 */
export function resolveAliases(keys: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(keys)].filter(Boolean).sort((a, b) => a.split(" ").length - b.split(" ").length || a.length - b.length || cmp(a, b));
  const canon = new Map<string, string>(); const roots: string[] = [];
  for (const k of sorted) {
    const t = k.split(" ");
    const root = roots.find((r) => { const rt = r.split(" "); return rt[0]!.length >= 4 && rt.length < t.length && rt.every((w, i) => t[i] === w); });
    if (root) canon.set(k, root); else { canon.set(k, k); roots.push(k); }
  }
  return canon;
}

export type CareerStatus = "analyzed" | "applied" | "interviewing" | "offer" | "rejected" | "withdrawn" | "closed";
const ACTIVE: CareerStatus[] = ["applied", "interviewing", "offer"];
const SHEET_RANK: Record<string, number> = { applied: 1, interviewing: 2, offer: 3 };
/** Initial status from the sheet: the furthest active stage any row reports; else a terminal state if every row is terminal. */
function sheetInitial(rows: SheetOpportunity[]): CareerStatus {
  const act = rows.filter((r) => SHEET_RANK[r.status]).sort((a, b) => SHEET_RANK[b.status]! - SHEET_RANK[a.status]!)[0];
  if (act) return act.status as CareerStatus;
  if (rows.length && rows.every((r) => ["rejected", "withdrawn", "closed"].includes(r.status))) return [...rows.map((r) => r.status)].sort()[0] as CareerStatus;
  return "analyzed";
}
/** Event-driven state machine (time order, ties by record id). Rejection is terminal unless later engagement reopens. */
function step(cur: CareerStatus, k: EvidenceKind): CareerStatus {
  switch (k) {
    case "offer": return "offer";
    case "rejection": return cur === "offer" ? "offer" : "rejected";
    case "interview": case "screen": return cur === "offer" ? "offer" : "interviewing";
    // A NEW application after a terminal outcome reopens (live: Amazon rejected one requisition on 09/20, Julian applied
    // to another on 10/05; Vallum Associates rejected 08/27, re-applied 10/09). A "viewed" notice never reopens.
    case "application": return cur === "analyzed" || cur === "rejected" || cur === "withdrawn" || cur === "closed" ? "applied" : cur;
    case "viewed": return cur === "analyzed" ? "applied" : cur;
  }
}

export interface OrgTrace { orgKey: string; aliases: string[]; org: string; initialFromSheet: CareerStatus; records: Array<{ recordId: string; at: string; kind: EvidenceKind; rule: string; transition: string }>; sheetRows: string[]; status: CareerStatus; included: boolean; reason: string }
export interface ActiveOpportunity { org: string; orgKey: string; aliases: string[]; status: CareerStatus; titles: string[]; lastEvidenceAt: string | null;
  evidence: Array<{ recordId: string; at: string; kind: EvidenceKind; subject: string }>; sheetRows: string[]; contact: string | null; sheetStatus: string | null;
  followupDue: string | null; followup: string | null }
export interface CareerInterpretation {
  interpreterVersion: string; snapshotDigest: string; acquiredAt: string; asOf: string; complete: boolean; problems: string[];
  active: ActiveOpportunity[];
  closed: Array<{ org: string; orgKey: string; aliases: string[]; status: CareerStatus; lastEvidenceAt: string | null; evidenceIds: string[] }>;
  conflicts: string[];
  pipeline: { total: number; byStatus: Record<string, number>; shortlist: Array<{ org: string; title: string; score: number | null; eligibility: string | null }>; sheetRows: number; dropped: number; duplicates: number };
  traces: { records: RecordTrace[]; orgs: OrgTrace[] };
  counts: { records: number; excluded: number; unclassified: number; unparsed: number; candidates: number };
}

const ELIGIBLE = (e: string | null) => !e || /no restriction/i.test(e);
const FOLLOWUP_DAYS = 7;

export function interpretCareer(s: CareerSnapshot, opts: { asOf?: string } = {}): CareerInterpretation {
  const asOf = (opts.asOf ?? s.acquiredAt).slice(0, 10);
  const sheet = s.sheet.ok && s.sheet.csv ? extractSheet(s.sheet.csv) : { rows: [] as SheetOpportunity[], dropped: 0, duplicates: 0 };
  const records = evidenceRecords(s);
  const sheetKeys = sheet.rows.map((r) => normOrg(r.org)).filter(Boolean);
  // Two classification passes so "Title - Org" can use orgs learned from unambiguous records (order-independent).
  const known = new Set(sheetKeys);
  for (const t of records.map((r) => classifyRecord(r, known))) if (t.orgKey) known.add(t.orgKey);
  const traces = records.map((r) => classifyRecord(r, known));
  const canon = resolveAliases([...sheetKeys, ...traces.flatMap((t) => (t.orgKey ? [t.orgKey] : []))]);
  const aliasesOf = (k: string) => [...canon.entries()].filter(([, c]) => c === k).map(([a]) => a).sort(cmp);

  const sheetByOrg = new Map<string, SheetOpportunity[]>();
  for (const r of sheet.rows) { const k = canon.get(normOrg(r.org)); if (k) sheetByOrg.set(k, [...(sheetByOrg.get(k) ?? []), r]); }
  const byOrg = new Map<string, Array<{ rec: EvidenceRecord; t: RecordTrace }>>();
  records.forEach((rec, i) => { const t = traces[i]!; if (t.stage === "candidate" && t.orgKey) { const k = canon.get(t.orgKey)!; byOrg.set(k, [...(byOrg.get(k) ?? []), { rec, t }]); } });
  // Orgs to evaluate: every org with evidence, plus sheet orgs whose rows report an active/terminal stage.
  const keys = new Set([...byOrg.keys(), ...[...sheetByOrg.entries()].filter(([, rows]) => sheetInitial(rows) !== "analyzed").map(([k]) => k)]);

  const orgTraces: OrgTrace[] = [];
  const active: ActiveOpportunity[] = [];
  const closed: CareerInterpretation["closed"] = [];
  const conflicts: string[] = [];
  for (const key of [...keys].sort(cmp)) {
    const evs = byOrg.get(key) ?? [];   // already in total order (records were sorted)
    const rows = sheetByOrg.get(key) ?? [];
    const names = [...evs.map((e) => e.t.org!), ...rows.map((r) => r.org)];
    const display = [...names].sort((a, b) => b.length - a.length || cmp(a, b))[0]!;
    const init = sheetInitial(rows);
    let st: CareerStatus = init;
    const recs: OrgTrace["records"] = [];
    for (const { rec, t } of evs) { const before = st; st = step(st, t.kind!); recs.push({ recordId: rec.id, at: rec.at, kind: t.kind!, rule: t.rule!, transition: `${before}→${st}` }); }
    const sheetStatus = rows.length ? [...new Set(rows.map((r) => r.status))].sort(cmp).join(",") : null;
    if (rows.length && evs.length && sheetInitial(rows) !== st)
      conflicts.push(`${display}: Career Copilot sheet says "${sheetStatus}" but ${evs.length} email/calendar record(s) show "${st}" (records ${evs.map((e) => e.rec.id).join(", ")})`);
    const last = evs.length ? evs[evs.length - 1]!.rec.at : null;
    const included = ACTIVE.includes(st);
    const aliases = aliasesOf(key);
    const reason = included ? `status ${st} from ${evs.length} record(s)${rows.length ? ` + ${rows.length} sheet row(s)` : ""}` : `status ${st} — closed, not active`;
    orgTraces.push({ orgKey: key, aliases, org: display, initialFromSheet: init, records: recs, sheetRows: rows.map((r) => r.sourceId).sort(cmp), status: st, included, reason });
    if (included) {
      const contactRec = evs.map((e) => e.rec).filter((r) => r.source === "gmail" && r.from && !/no-?reply|linkedin|lever|workable|greenhouse|otter|julian|correounivalle/i.test(r.from)).pop();
      const contact = contactRec ? (/^"?([^"<]+?)"?\s*</.exec(contactRec.from)?.[1]?.trim() ?? null) : null;
      const due = last ? new Date(Date.parse(last.slice(0, 10)) + FOLLOWUP_DAYS * 86_400_000).toISOString().slice(0, 10) : null;
      const titles = [...new Set([...rows.map((r) => r.title), ...evs.flatMap((e) => (e.t.title ? [e.t.title] : []))])].sort(cmp);
      active.push({ org: display, orgKey: key, aliases, status: st, titles, lastEvidenceAt: last, sheetRows: rows.map((r) => r.sourceId).sort(cmp),
        evidence: evs.map((e) => ({ recordId: e.rec.id, at: e.rec.at, kind: e.t.kind!, subject: decodeEntities(e.rec.subject).slice(0, 120) })),
        contact, sheetStatus, followupDue: due,
        followup: due && due <= asOf ? `Follow up with ${contact ?? display} — last evidence ${last!.slice(0, 10)}, follow-up due ${due}` : null });
    } else closed.push({ org: display, orgKey: key, aliases, status: st, lastEvidenceAt: last, evidenceIds: evs.map((e) => e.rec.id) });
  }
  const byStatus: Record<string, number> = {};
  for (const r of sheet.rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const engaged = new Set(orgTraces.map((o) => o.orgKey));
  const shortlist = sheet.rows.filter((r) => r.status === "analyzed" && !engaged.has(canon.get(normOrg(r.org)) ?? "") && (r.fitScore ?? 0) >= 88 && ELIGIBLE(r.eligibility))
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || cmp(a.org, b.org) || cmp(a.title, b.title) || cmp(a.sourceId, b.sourceId)).slice(0, 10)
    .map((r) => ({ org: r.org, title: r.title, score: r.fitScore, eligibility: r.eligibility }));
  const ineligible = sheet.rows.filter((r) => !ELIGIBLE(r.eligibility)).length;
  if (ineligible) conflicts.push(`${ineligible} sheet posting(s) list citizenship/clearance requirements — kept, excluded from the shortlist`);
  if (!s.completeness.complete) conflicts.push(`INCOMPLETE SNAPSHOT — ${s.completeness.problems.join("; ")}`);
  const counts = { records: records.length, excluded: traces.filter((t) => t.stage === "excluded").length, unclassified: traces.filter((t) => t.stage === "unclassified").length,
    unparsed: traces.filter((t) => t.stage === "unparsed").length, candidates: traces.filter((t) => t.stage === "candidate").length };
  return { interpreterVersion: INTERPRETER_VERSION, snapshotDigest: snapshotDigest(s), acquiredAt: s.acquiredAt, asOf, complete: s.completeness.complete, problems: s.completeness.problems,
    active, closed, conflicts: conflicts.sort(cmp), pipeline: { total: sheet.rows.length, byStatus, shortlist, sheetRows: sheet.rows.length, dropped: sheet.dropped, duplicates: sheet.duplicates },
    traces: { records: traces, orgs: orgTraces }, counts };
}

/** Digest of everything decision-relevant: opportunity set, statuses, evidence links, conflicts, shortlist, follow-ups. */
export function interpretationDigest(i: CareerInterpretation): string {
  return sha(canonical({ v: i.interpreterVersion, asOf: i.asOf, active: i.active, closed: i.closed, conflicts: i.conflicts, pipeline: i.pipeline })).slice(0, 16);
}
/** The opportunity set and statuses only (what must not move without new evidence). */
export function opportunitySetDigest(i: CareerInterpretation): string {
  return sha(canonical({ active: i.active.map((o) => [o.orgKey, o.status]), closed: i.closed.map((o) => [o.orgKey, o.status]) })).slice(0, 16);
}

/** Per-organization end-to-end trace: found (which records mention it, via which query) → parsed (classification) →
 *  candidate → merged (alias) → final (included/excluded with the reason). */
export function traceOrg(s: CareerSnapshot, i: CareerInterpretation, name: string) {
  const needle = normOrg(name);
  const recs = evidenceRecords(s);
  const mentions = recs.filter((r) => normOrg(`${decodeEntities(r.subject)} ${decodeEntities(r.snippet)} ${r.from}`).includes(needle));
  const traceById = new Map(i.traces.records.map((t) => [`${t.account}|${t.recordId}`, t]));
  const org = i.traces.orgs.find((o) => o.aliases.some((a) => a === needle || a.startsWith(`${needle} `) || needle.startsWith(`${a} `)) || o.orgKey === needle);
  const sheetRows = s.sheet.ok && s.sheet.csv ? extractSheet(s.sheet.csv).rows.filter((r) => normOrg(r.org).includes(needle)).map((r) => ({ id: r.sourceId, org: r.org, title: r.title, status: r.status })) : [];
  return {
    name, snapshotDigest: snapshotDigest(s), interpreterVersion: i.interpreterVersion,
    found: mentions.map((r) => { const t = traceById.get(`${r.account}|${r.id}`)!; return { recordId: r.id, account: r.account, at: r.at, subject: decodeEntities(r.subject).slice(0, 120), from: r.from, acquiredVia: r.queries,
      stage: t.stage, kind: t.kind ?? null, rule: t.rule ?? null, extractedOrg: t.org ?? null, mergedInto: t.orgKey ? org && org.aliases.includes(t.orgKey) ? org.orgKey : t.orgKey : null, reason: t.reason }; }),
    sheetRows,
    final: org ? { orgKey: org.orgKey, aliases: org.aliases, status: org.status, included: org.included, reason: org.reason, transitions: org.records } : { included: false, reason: mentions.length ? "records mention it but none yielded it as the organization (see stages)" : "no record in the snapshot mentions it" },
  };
}

export interface SnapshotDelta {
  sameInput: boolean; sameOutput: boolean; sameOpportunitySet: boolean;
  addedRecords: Array<{ id: string; account: string; at: string; subject: string }>; removedRecords: Array<{ id: string; account: string; at: string; subject: string; reason: string }>;
  sheet: { changed: boolean; rowsAdded: string[]; rowsRemoved: string[]; statusChanged: Array<{ id: string; from: string; to: string }> };
  oppAdded: Array<{ org: string; explainedBy: string[] }>; oppRemoved: Array<{ org: string; becameStatus: string | null; explainedBy: string[] }>;
  statusChanged: Array<{ org: string; from: string; to: string; explainedBy: string[] }>; followupsDue: string[];
  unexplained: string[];
}

/** Record-level delta between two snapshots and which records explain each opportunity change. An opportunity change
 *  with no new/removed record (or sheet row) behind it is UNEXPLAINED — a reproducibility failure, never a data fix. */
export function snapshotDelta(prev: CareerSnapshot, cur: CareerSnapshot, opts: { asOfPrev?: string; asOfCur?: string } = {}): SnapshotDelta {
  const k = (r: EvidenceRecord) => `${r.source}|${r.account}|${r.id}`;
  const a = new Map(evidenceRecords(prev).map((r) => [k(r), r])), b = new Map(evidenceRecords(cur).map((r) => [k(r), r]));
  const missingReason = new Map<string, string>((cur.carryForward ?? []).flatMap((c) => c.missing.map((m): [string, string] => [`gmail|${c.account}|${m.id}`, m.reason])));
  const added = [...b.keys()].filter((x) => !a.has(x)).sort(cmp).map((x) => b.get(x)!);
  const removed = [...a.keys()].filter((x) => !b.has(x)).sort(cmp).map((x) => a.get(x)!);
  const ip = interpretCareer(prev, opts.asOfPrev ? { asOf: opts.asOfPrev } : {}), ic = interpretCareer(cur, opts.asOfCur ? { asOf: opts.asOfCur } : {});
  const rowsP = new Map((prev.sheet.csv ? extractSheet(prev.sheet.csv).rows : []).map((r) => [r.sourceId, r])), rowsC = new Map((cur.sheet.csv ? extractSheet(cur.sheet.csv).rows : []).map((r) => [r.sourceId, r]));
  const rowsAdded = [...rowsC.keys()].filter((x) => !rowsP.has(x)).sort(cmp), rowsRemoved = [...rowsP.keys()].filter((x) => !rowsC.has(x)).sort(cmp);
  const rowStatus = [...rowsC.keys()].filter((x) => rowsP.has(x) && rowsP.get(x)!.status !== rowsC.get(x)!.status).sort(cmp).map((x) => ({ id: x, from: rowsP.get(x)!.status, to: rowsC.get(x)!.status }));
  const changedRows = new Set([...rowsAdded, ...rowsRemoved, ...rowStatus.map((r) => r.id)]);
  const addedIds = new Set(added.map((r) => r.id)), removedIds = new Set(removed.map((r) => r.id));
  type Opp = { org: string; aliases: string[]; status: string; ids: string[]; rows: string[] };
  const opps = (i: CareerInterpretation): Opp[] => [...i.active.map((o) => ({ org: o.org, aliases: o.aliases, status: o.status, ids: o.evidence.map((e) => e.recordId), rows: o.sheetRows })),
    ...i.closed.map((o) => ({ org: o.org, aliases: o.aliases, status: o.status, ids: o.evidenceIds, rows: i.traces.orgs.find((t) => t.orgKey === o.orgKey)?.sheetRows ?? [] }))];
  const P = opps(ip), C = opps(ic);
  const match = (o: Opp, set: Opp[]) => set.find((x) => x.aliases.some((al) => o.aliases.includes(al)));
  const why = (o: Opp, ids: Set<string>) => [...o.ids.filter((id) => ids.has(id)), ...o.rows.filter((r) => changedRows.has(r)).map((r) => `sheet:${r}`)];
  const isActive = (st: string) => (ACTIVE as string[]).includes(st);
  const oppAdded = C.filter((o) => isActive(o.status) && !(match(o, P) && isActive(match(o, P)!.status))).map((o) => ({ org: o.org, explainedBy: why(o, addedIds) }));
  const oppRemoved = P.filter((o) => isActive(o.status) && !(match(o, C) && isActive(match(o, C)!.status))).map((o) => { const now = match(o, C);
    return { org: o.org, becameStatus: now?.status ?? null, explainedBy: [...why(o, removedIds), ...(now ? why(now, addedIds) : [])] }; });
  const statusChanged = C.filter((o) => { const p = match(o, P); return p && p.status !== o.status && isActive(p.status) === isActive(o.status); })
    .map((o) => ({ org: o.org, from: match(o, P)!.status, to: o.status, explainedBy: why(o, addedIds) }));
  const dueP = new Set(ip.active.filter((o) => o.followup).map((o) => o.orgKey));
  const followupsDue = ic.active.filter((o) => o.followup && !dueP.has(o.orgKey)).map((o) => `${o.org} (due ${o.followupDue})`);
  const unexplained = [...oppAdded, ...oppRemoved, ...statusChanged].filter((o) => !o.explainedBy.length).map((o) => o.org);
  return {
    sameInput: snapshotDigest(prev) === snapshotDigest(cur), sameOutput: interpretationDigest(ip) === interpretationDigest(ic), sameOpportunitySet: opportunitySetDigest(ip) === opportunitySetDigest(ic),
    addedRecords: added.map((r) => ({ id: r.id, account: r.account, at: r.at, subject: decodeEntities(r.subject).slice(0, 100) })),
    removedRecords: removed.map((r) => ({ id: r.id, account: r.account, at: r.at, subject: decodeEntities(r.subject).slice(0, 100), reason: missingReason.get(k(r)) ?? "not returned by any query and not re-verified" })),
    sheet: { changed: (prev.sheet.sha256 ?? null) !== (cur.sheet.sha256 ?? null), rowsAdded, rowsRemoved, statusChanged: rowStatus },
    oppAdded, oppRemoved, statusChanged, followupsDue, unexplained,
  };
}
