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
import { dedupeKey, extractSheet, normOrg } from "./bootstrap.js";
export const INTERPRETER_VERSION = "career-interpret-6";
/** Fixed acquisition lower bound (NOT rolling with the clock, so a record can't age out between two runs). */
export const CAREER_EPOCH = "2026/06/01";
export const CALENDAR_AHEAD_DAYS = 120;
/** Fixed, recorded acquisition queries — no ranking, no top-N. Body phrases included: ATS mails often carry the
 *  application wording only in the body ("Pricing Analyst - Resource Innovations"). */
export const CAREER_QUERIES = {
    applications: `(subject:application OR subject:applying OR subject:applied OR "thanks for applying" OR "thank you for applying" OR "thank you for your applying" OR "thank you for your interest" OR "your application")`,
    interviews: `subject:(interview OR "phone screen" OR screening OR "next steps")`,
    outcomes: `("regret to inform" OR "not to move forward" OR "not moving forward" OR "unable to move forward" OR "not be proceeding" OR "move forward with other" OR "move forward with another" OR "made the decision" OR "position has been filled" OR "no longer under consideration" OR "not been selected" OR "offer letter" OR "pleased to offer")`,
};
export const CALENDAR_QUERIES = ["interview", "screen"];
export const GMAIL_MAX = 2000;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const errText = (e) => String(e?.message ?? e).slice(0, 200);
/** Canonical JSON (sorted keys) so digests depend on content, never on key order. */
export function canonical(v) {
    if (Array.isArray(v))
        return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object")
        return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
    return JSON.stringify(v ?? null);
}
// ---------------------------------------------------------------------------------------------------------------
// ACQUIRE
/**
 * Exhaustive, recorded, no silent drops. `prev` (the last stored snapshot) pins the sheet file and lets every
 * previously seen Gmail record be RE-VERIFIED by id when a search does not return it: evidence can only leave the
 * snapshot if it was deleted/trashed at the source (recorded with the reason), never because of search behaviour.
 */
export async function acquireCareerSnapshot(src, sheetTitle, now = new Date(), prev, cache = {}) {
    const day = 86_400_000;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const window = { gmailAfter: CAREER_EPOCH, calendarFrom: `${CAREER_EPOCH.replace(/\//g, "-")}T00:00:00.000Z`, calendarTo: new Date(today + CALENDAR_AHEAD_DAYS * day).toISOString() };
    const problems = [];
    const pinned = prev?.snapshot.sheet.id ?? null;
    let sheet = { ok: false, error: "no sheet source" };
    if (src.sheetCsv) {
        try {
            const s = await src.sheetCsv(sheetTitle, pinned ?? undefined);
            sheet = s ? { ok: true, name: s.name, modified: s.modified, sha256: sha(s.csv), csv: s.csv, pinnedFrom: pinned, ...(s.id ? { id: s.id } : {}), ...(s.account ? { account: s.account } : {}),
                ...(s.candidates ? { candidates: s.candidates } : {}), ...(s.errors?.length ? { accountErrors: s.errors } : {}) } : { ok: false, error: "sheet not found" };
            if (s && pinned && s.id && s.id !== pinned)
                problems.push(`sheet: pinned file ${pinned} no longer available; using ${s.id}`);
            if (s?.errors?.length)
                problems.push(`sheet lookup errors: ${s.errors.join("; ")}`);
        }
        catch (e) {
            sheet = { ok: false, error: errText(e) };
        }
    }
    if (!sheet.ok)
        problems.push(`sheet: ${sheet.error}`);
    const gmail = [];
    for (const [key, base] of Object.entries(CAREER_QUERIES)) {
        const q = `after:${window.gmailAfter} ${base}`;
        let per = [];
        if (src.gmailEnumerate) {
            try {
                per = await src.gmailEnumerate(q, { maxMessages: GMAIL_MAX, ...cache });
            }
            catch (e) {
                problems.push(`gmail ${key}: ${errText(e)}`);
            }
        }
        else
            problems.push("gmail: no source");
        for (const p of per) {
            gmail.push({ key, query: q, account: p.account, ok: p.ok, ...(p.error ? { error: p.error } : {}), pages: p.pages, truncated: p.truncated, ids: p.ids, vanished: [...(p.vanished ?? [])].sort(), records: p.records,
                ...(p.fetched !== undefined ? { fetched: p.fetched, reused: p.reused ?? 0 } : {}) });
            if (!p.ok)
                problems.push(`gmail ${key} @ ${p.account}: ${p.error}`);
            if (p.truncated)
                problems.push(`gmail ${key} @ ${p.account}: truncated at ${p.records.length} messages`);
        }
    }
    // Carry-forward: every Gmail record of the previous snapshot that no search returned now is re-fetched by id.
    const carryForward = [];
    let searchMisses = 0;
    if (prev) {
        const have = new Set(gmail.flatMap((g) => g.records.map((r) => `${g.account}|${r.id}`)));
        const want = new Map();
        for (const g of [...prev.snapshot.gmail, ...(prev.snapshot.carryForward ?? [])])
            for (const r of g.records)
                if (!have.has(`${g.account}|${r.id}`))
                    want.set(g.account, (want.get(g.account) ?? new Set()).add(r.id));
        for (const account of [...want.keys()].sort()) {
            const ids = [...want.get(account)].sort();
            searchMisses += ids.length;
            if (!src.gmailMetadata) {
                carryForward.push({ account, fromSnapshot: prev.digest, requested: ids.length, ok: false, error: "no re-verification source", records: [], missing: [] });
                problems.push(`carry-forward @ ${account}: no re-verification source`);
                continue;
            }
            try {
                const r = await src.gmailMetadata(account, ids, cache);
                carryForward.push({ account, fromSnapshot: prev.digest, requested: ids.length, ok: true, records: r.records, missing: r.missing });
            }
            catch (e) {
                carryForward.push({ account, fromSnapshot: prev.digest, requested: ids.length, ok: false, error: errText(e), records: [], missing: [] });
                problems.push(`carry-forward @ ${account}: ${errText(e)}`);
            }
        }
    }
    const calendar = [];
    for (const q of CALENDAR_QUERIES) {
        let per = [];
        if (src.calendarEnumerate) {
            try {
                per = await src.calendarEnumerate(q, window.calendarFrom, window.calendarTo);
            }
            catch (e) {
                problems.push(`calendar "${q}": ${errText(e)}`);
            }
        }
        for (const p of per) {
            calendar.push({ query: q, account: p.account, ok: p.ok, ...(p.error ? { error: p.error } : {}), pages: p.pages, records: p.records });
            if (!p.ok)
                problems.push(`calendar "${q}" @ ${p.account}: ${p.error}`);
        }
    }
    // Mutation check: the sheet is re-read after acquisition; a change during the run is recorded (snapshot incomplete).
    if (sheet.ok && src.sheetCsv) {
        try {
            const again = await src.sheetCsv(sheetTitle, sheet.id);
            if (again) {
                sheet.modifiedAfter = again.modified;
                sheet.mutatedDuringRun = again.modified !== sheet.modified || sha(again.csv) !== sheet.sha256;
            }
        }
        catch (e) {
            problems.push(`sheet re-read: ${errText(e)}`);
        }
        if (sheet.mutatedDuringRun)
            problems.push("sheet changed during acquisition");
    }
    return { version: 2, acquiredAt: now.toISOString(), interpreterVersion: INTERPRETER_VERSION, window, sheet, gmail, carryForward, calendar,
        completeness: { complete: problems.length === 0, problems, searchMisses } };
}
/** Digest of the INPUT content: the evidence records + sheet bytes + fixed window. Acquisition time, paging and how
 *  a record was found (search vs carry-forward) are excluded, so the same evidence always has the same digest. */
export function snapshotDigest(s) {
    const recs = evidenceRecords(s).map((r) => ({ id: r.id, source: r.source, account: r.account, at: r.at, subject: r.subject, from: r.from, snippet: r.snippet, body: r.body, templates: r.templates }));
    return sha(canonical({ gmailAfter: s.window.gmailAfter, sheet: s.sheet.sha256 ?? null, recs, complete: s.completeness.complete })).slice(0, 16);
}
/** All distinct evidence records, deduped by (source, account, id), in a total order independent of acquisition order. */
export function evidenceRecords(s) {
    const m = new Map();
    const addGmail = (account, r, via) => {
        const k = `gmail|${account}|${r.id}`;
        const ex = m.get(k);
        if (ex) {
            if (!ex.queries.includes(via))
                ex.queries.push(via);
            return;
        }
        m.set(k, { id: r.id, source: "gmail", account, at: new Date(r.internalDate).toISOString(), subject: r.subject, from: r.from, snippet: r.snippet, body: r.body ?? "", templates: [...(r.templates ?? [])].sort(), queries: [via] });
    };
    for (const g of s.gmail)
        for (const r of g.records)
            addGmail(g.account, r, g.key);
    for (const c of s.carryForward ?? [])
        for (const r of c.records)
            addGmail(c.account, r, "carry-forward");
    for (const c of s.calendar)
        for (const r of c.records) {
            const k = `calendar|${c.account}|${r.id}`;
            const ex = m.get(k);
            if (ex) {
                if (!ex.queries.includes(`cal:${c.query}`))
                    ex.queries.push(`cal:${c.query}`);
                continue;
            }
            const at = /^\d{4}-\d{2}-\d{2}$/.test(r.start) ? `${r.start}T00:00:00.000Z` : new Date(r.start).toISOString();
            m.set(k, { id: r.id, source: "calendar", account: c.account, at, subject: r.summary, from: "", snippet: "", body: "", templates: [], queries: [`cal:${c.query}`] });
        }
    const out = [...m.values()];
    for (const r of out)
        r.queries.sort();
    return out.sort((a, b) => cmp(a.at, b.at) || cmp(a.source, b.source) || cmp(a.account, b.account) || cmp(a.id, b.id));
}
/** Locale-independent comparison (localeCompare can differ between runtimes/ICU builds). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Gmail snippets (and some subjects) are HTML-escaped: "we&#39;ve made the decision", "FP&amp;A". */
export function decodeEntities(s, keepLines = false) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => {
        const l = e.toLowerCase();
        if (l === "amp")
            return "&";
        if (l === "lt")
            return "<";
        if (l === "gt")
            return ">";
        if (l === "quot")
            return '"';
        if (l === "apos")
            return "'";
        if (l === "nbsp")
            return " ";
        const n = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    }).replace(/[͏​-‍⁠﻿]/g, "").replace(keepLines ? /[^\S\n]+/g : /\s+/g, " ").replace(/ *\n */g, "\n").trim();
}
const ORG = String.raw `([A-Z0-9][\w&.,'’-]*(?:\s+(?:[A-Z0-9&][\w&.,'’-]*|of|and|for|the|de|y)){0,5})`;
/** Case-insensitive literal phrase without making the whole regex /i (the ORG capture must stay case-sensitive). */
const ci = (phrase) => phrase.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const ROLE_TAIL = /\b(analyst|manager|associate|specialist|accountant|director|coordinator|consultant|controller|intern|strategist|estimator|officer|lead)$/i;
const TITLE_WORDS = /^(senior|sr\.?|junior|jr\.?|lead|principal|staff|associate|assistant|financial|finance|pricing|accounting|business|data|cost|budget|program|analyst|manager|director|specialist|coordinator|consultant|fp&a|fp|structured|entry)\b/i;
/** Strong outcome wording only — safe on bodies (bare "unfortunately" only counts in subject/snippet: confirmations say
 *  "unfortunately we can't reply to everyone"). Live examples: JHU, Cvent ("Thank You For Applying" — a rejection), Accenture. */
/** The posting itself closed (not a decision about Julian): Amazon "this position is no longer available". */
const POSTING_CLOSED = /\b(position is no longer available|no longer accepting applications|(?:posting|requisition) (?:has been |was )?(?:closed|cancell?ed))\b/i;
const REJECT = /\b(regret to inform|not (?:to )?(?:move|moving) forward with (?:your|you)|decided not to (?:move forward|proceed|pursue)|(?:will|are) not be (?:moving forward|proceeding)|not be proceeding|unable to move forward|(?:decided|chosen|elected|decision) to (?:move forward|proceed|pursue|go|progress|continue) with (?:other|another) (?:candidate|applicant)|(?:move|go|progress) (?:forward )?with (?:other|another) (?:candidate|applicant)|we(?:'|’)?ve made the decision|we have made the decision|no longer (?:being )?(?:considered|under consideration)|position (?:has been|is now) (?:filled|closed)|(?:have|has) not been selected|not selected (?:to|for)|pursue other candidates)/i;
const OFFER = /\b(offer letter|pleased to (?:offer|extend)|extend(?:ing)? (?:you )?an offer|job offer|offer of employment)\b/i;
const NOT_ORG = /^(julian|your|you|the|a|an|us|me|our|linkedin|indeed|workable|lever|greenhouse)$/i;
const ATS_OR_JOBS = /(\.jobs>?\s*$|jobs-noreply@linkedin|lever\.co|greenhouse|workablemail|workable|ashbyhq|smartrecruiters|icims|myworkday|jobvite|bamboohr|paylocity|ultipro|taleo|successfactors|jazzhr|breezy|recruitee|teamtailor|rippling|dayforce|paycom)/i;
const JOB_CONTEXT = /\b(position|role|job|analyst|candidate|candidacy|hiring|recruit\w*|talent|resume|interview\w*|opening|requisition|employment)\b/i;
const GENERIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|yahoo|ouryahoo|icloud|aol|protonmail|glassdoor|linkedin|applytojob|hirebridge|myworkdayjobs|lever|greenhouse|greenhouse-jobs|workable|workablemail|ashbyhq|smartrecruiters|icims|myworkday|workday|jobvite|bamboohr|indeed|ziprecruiter|otter|zoom|google|calendly|paylocity|adp|ultipro|taleo|successfactors|jazzhr|breezy|recruitee|teamtailor|rippling|dayforce|paycom|correounivalle)\.$/i;
const NOISE = [
    { re: /newsletters?-noreply|messages-noreply|jobs-listings|jobalerts?|job-alerts|digest|notifications?-noreply|match\.indeed\.com|alert@indeed/i, field: "from", why: "newsletter / job-alert / job-match sender, not an application record" },
    { re: /\b(see hiring trends|jobs? (?:for you|alert)|new .*jobs? update|recommended jobs?|is hiring|top applicant|people also viewed|job recommendations?|apply now|apply to your saved jobs|view your application updates|hired roles near you)\b/i, field: "subject", why: "job-board marketing / digest / unfinished application, not an application record" },
];
function cleanOrg(s) {
    let o = s.split(/[.,;:!?](?:\s|$)/)[0].replace(/[.,;:!'’-]+$/, "").trim();
    for (let prev = ""; prev !== o;) {
        prev = o;
        o = o.replace(/\s+(?:position|role|job|team|careers?|inc\.?|llc|ltd|of|and|for|the|de|y)$/i, "").trim();
    }
    return o;
}
const validOrg = (o) => !!o && o.length > 1 && !TITLE_WORDS.test(o) && !NOT_ORG.test(o) && !ROLE_TAIL.test(o);
/** Classify one record: kind, organization (FIRST matching deterministic rule) and the specific job it concerns. */
export function classifyRecord(r, knownOrgKeys) {
    const t = classifyOrg(r, knownOrgKeys);
    if (t.stage !== "candidate" && t.stage !== "unparsed")
        return t;
    const j = jobIdentity(r, t);
    return { ...t, ...(j.title ? { title: j.title } : {}), ...(j.reqId ? { reqId: j.reqId } : {}), ...(j.location ? { location: j.location } : {}), ...(j.via ? { jobVia: j.via } : {}) };
}
function classifyOrg(r, knownOrgKeys) {
    const subject = decodeEntities(r.subject), snippet = decodeEntities(r.snippet);
    const base = { recordId: r.id, source: r.source, account: r.account, at: r.at, subject: subject.slice(0, 160), queries: r.queries };
    for (const n of NOISE)
        if (n.re.test(n.field === "from" ? r.from : subject))
            return { ...base, stage: "excluded", reason: n.why };
    const subj = subject.replace(/^(?:(?:re|fwd?|fw|canceled|cancelled|updated invitation|invitation|accepted|declined):\s*)+/i, "").trim();
    const body = decodeEntities(r.body);
    const head = `${subj} ${snippet}`; // subject + snippet
    const text = `${head} ${body}`; // + body text (URLs removed)
    let kind = null;
    let via = "";
    if (r.templates.some((t) => /application_rejected/.test(t))) {
        kind = "rejection";
        via = `LinkedIn template ${r.templates.find((t) => /application_rejected/.test(t))}`;
    }
    else if (OFFER.test(text)) {
        kind = "offer";
        via = "offer wording";
    }
    else if (!REJECT.test(text) && POSTING_CLOSED.test(head)) {
        kind = "posting_closed";
        via = "posting closed wording";
    }
    else if (REJECT.test(text) || /\bunfortunately\b/i.test(head)) {
        kind = "rejection";
        via = REJECT.test(head) || /\bunfortunately\b/i.test(head) ? "rejection wording (subject/snippet)" : "rejection wording (body)";
    }
    else if (/\b(you(?:'|’)?ve withdrawn|withdrawn your|withdrew your|application (?:has been|was) withdrawn)\b/i.test(head)) {
        kind = "withdrawal";
        via = "withdrawal wording";
    }
    else if (/\b(keep track of your application|if you have completed the application|application (?:for .{3,160}? )?is incomplete)\b/i.test(head)) {
        kind = "started";
        via = "application started (not confirmed submitted)";
    }
    else if (/\b(phone screen|screening call|screening interview)\b/i.test(subj))
        kind = "screen";
    else if (/\binterview\b/i.test(subj) && !/\b(how to|tips|prepare for your|ace your)\b/i.test(subj))
        kind = "interview";
    else if (/application (?:for .{3,120}? )?was viewed/i.test(subj) || r.templates.some((t) => /application_viewed/.test(t)))
        kind = "viewed";
    else if (/\b(application|applying|applied|thanks for applying|thank you for applying|thank you for your interest)\b/i.test(head))
        kind = "application";
    if (!kind)
        return { ...base, stage: "unclassified", reason: "no application/interview/outcome signal" };
    if (!ATS_OR_JOBS.test(r.from) && !JOB_CONTEXT.test(head) && !/\(ID:\s*\d{5,}\)/.test(head) && !/\b(?:thank(?:s| you) for applying|received your application)\b/i.test(head) && !/[Aa]pplication to [A-Z]/.test(head) && r.source === "gmail")
        return { ...base, stage: "unclassified", kind, reason: `${kind} wording but no job context (not an ATS/LinkedIn sender, no role/position/hiring words)` };
    // [name, pattern, org group, title group, where: s=subject n=snippet b=body]. Bodies are only searched by rules that
    // cannot be fooled by the job recommendations LinkedIn appends ("View similar jobs … at McKesson").
    const rules = [
        ["linkedin:application_to_title_at_org", new RegExp(String.raw `[Aa]pplication (?:to|for) (.{3,120}?) at ${ORG}`), 2, 1, "sn"],
        ["notice:application_sent_viewed_received", new RegExp(String.raw `[Aa]pplication (?:for (.{3,120}?) )?(?:was )?(?:sent to|viewed by|received by|submitted to) ${ORG}`), 2, 1, "sn"],
        ["linkedin:update_from_org", new RegExp(String.raw `^Your update from ${ORG}`), 1, 0, "b"],
        ["ats:thanks_for_applying_to_org", new RegExp(String.raw `(?:${ci("thanks")}|${ci("thank you")}) ${ci("for")} (?:${ci("applying")}|${ci("your application")}|${ci("your interest")}|${ci("your applying")}|${ci("taking the time to apply")})(?: ${ci("to")}| ${ci("at")}| ${ci("in")}| ${ci("with")}| ${ci("for")})(?: ${ci("the")})?(?: (.{3,80}?) (?:${ci("position")}|${ci("role")}|${ci("job")}|${ci("opening")})(?: ${ci("at")}| ${ci("with")}))? ${ORG}`), 2, 1, "snb"],
        ["subject:interest_in_org", new RegExp(String.raw `${ci("interest in")} ${ORG}\s*[!.]?$`), 1, 0, "s"],
        ["subject:title_at_sign_org", new RegExp(String.raw `(?:^|-\s)([^@-]{3,80}?)\s*@ ${ORG}\s*$`), 2, 1, "s"],
        ["subject:interview_or_screen_with_org", new RegExp(String.raw `(?:[Ii]nterview|[Pp]hone [Ss]creen|[Ss]creening(?: [Cc]all)?)(?: [Ii]nvitation)? (?:with|at|for) ${ORG}`), 1, 0, "s"],
    ];
    const fields = { s: subj, n: snippet, b: body };
    for (const [name, re, g, tg, where] of rules) {
        for (const w of where) {
            const m = re.exec(fields[w]);
            if (!m)
                continue;
            const org = cleanOrg(m[g] ?? "");
            if (!validOrg(org))
                continue;
            const title = tg && m[tg] ? m[tg].trim().replace(/^the\s+/i, "") : undefined;
            return { ...base, stage: "candidate", rule: name, kind, org, orgKey: normOrg(org), ...(title && !/^(julian|your)/i.test(title) ? { title } : {}), reason: `${kind}${via ? ` (${via})` : ""}; org by ${name}${w === "n" ? " (snippet)" : w === "b" ? " (body)" : ""}` };
        }
    }
    // "Title - Org" / "Org - Title": only when one side is an organization already known from the sheet or from an
    // unambiguous record (live: "Indeed Application: Senior Finance Analyst - Commercial Performance & Investment Review"
    // must not invent the employer "Commercial Performance & Investment Review").
    const dash = /^(.{2,90}?)\s+[-–|]\s+(.{2,90})$/.exec(subj);
    if (dash) {
        const [a, b] = [cleanOrg(dash[1]), cleanOrg(dash[2])];
        const pick = knownOrgKeys.has(normOrg(b)) ? b : knownOrgKeys.has(normOrg(a)) ? a : null;
        if (pick && validOrg(pick))
            return { ...base, stage: "candidate", rule: "subject:title_dash_known_org", kind, org: pick, orgKey: normOrg(pick), title: pick === b ? a : b, reason: `${kind}${via ? ` (${via})` : ""}; org by subject:title_dash_known_org` };
    }
    // Sender domain of a real company (not a mail provider or ATS).
    const dom = /@(?:[a-z0-9-]+\.)*?([a-z0-9-]+)\.[a-z]{2,6}(?:\.[a-z]{2})?>?\s*$/i.exec(r.from);
    if (dom && !GENERIC_DOMAINS.test(`${dom[1]}.`) && dom[1].length > 2) {
        const org = dom[1].charAt(0).toUpperCase() + dom[1].slice(1);
        return { ...base, stage: "candidate", rule: "sender_domain", kind, org, orgKey: normOrg(org), reason: `${kind}${via ? ` (${via})` : ""}; org by sender domain ${dom[1]}` };
    }
    return { ...base, stage: "unparsed", kind, reason: `${kind}${via ? ` (${via})` : ""} but no organization could be extracted by any rule` };
}
/**
 * Deterministic alias resolution: "altarum" and "altarum institute" are one organization when one key's tokens are a
 * prefix of the other's (first token ≥ 4 chars). The canonical key is the shortest; ALL aliases are kept so stored
 * opportunities match whichever spelling they were created under (stable identity).
 */
export function resolveAliases(keys) {
    const sorted = [...new Set(keys)].filter(Boolean).sort((a, b) => a.split(" ").length - b.split(" ").length || a.length - b.length || cmp(a, b));
    const canon = new Map();
    const roots = [];
    for (const k of sorted) {
        const t = k.split(" ");
        // Same name with/without spaces ("aircommunities" / "air communities") or a token-prefix ("altarum" ⊂ "altarum institute").
        const root = roots.find((r) => r.replace(/ /g, "") === k.replace(/ /g, "")) ?? roots.find((r) => { const rt = r.split(" "); return rt[0].length >= 3 && rt.length < t.length && rt.every((w, i) => t[i] === w); });
        if (root)
            canon.set(k, root);
        else {
            canon.set(k, k);
            roots.push(k);
        }
    }
    return canon;
}
// ---------------------------------------------------------------------------------------------------------------
// JOB IDENTITY (career-interpret-5): an opportunity is ONE job/application, never an employer.
//   identity = employer → requisition id (when the evidence has one) → job title (→ location when the same title
//   exists at several locations). An event names its job; an event that names no job attaches only when the
//   employer has exactly one job in evidence, otherwise it is kept as an UNASSIGNED employer event (never guessed).
const normTitle = (t) => t.toLowerCase().replace(/&/g, " and ").replace(/\bsr\b\.?/g, "senior").replace(/\bjr\b\.?/g, "junior").replace(/[^a-z0-9]+/g, " ").trim();
const normLoc = (l) => l.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A job title names a role; signatures ("Best regards", "Beth Young", "O | 734…") and boilerplate never do. */
const ROLE_WORD = /\b(analyst|manager|accountant|specialist|associate|director|coordinator|consultant|controller|strategist|estimator|officer|engineer|lead|intern|administrator|planner|advisor|adviser|auditor|economist|representative|assistant|partner|head|vp|vice president|executive|developer|scientist|bookkeeper|treasurer|clerk|cfo|fp&a|fp and a)\b/i;
const BAD_TITLE = /\b(julian|your application|job below|application data|safekeeping|personal information)\b|^(?:the )?(?:position|role|job|opening)$/i;
function cleanTitle(raw, org) {
    if (!raw)
        return undefined;
    let t = raw.replace(/^\s*reference role:\s*/i, "").replace(/\s*\(ID:?\s*\d+\)\s*/gi, " ").replace(/^\s*(?:R\d{4}-\d{3,}|R\d{6,}|req(?:uisition)?\s*#?\s*\w+)\s+/i, "")
        .replace(/\s+(?:\||[\w&]+ (?:recruitment|recruiting|talent acquisition) team\b).*$/i, "")
        .replace(/^(?:the|a|an)\s+/i, "").replace(/^position of\s+/i, "").replace(/\s+(?:position|role|job|opening)$/i, "").replace(/[\s.,;:!|-]+$/, "").replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 140 || BAD_TITLE.test(t) || !ROLE_WORD.test(t))
        return undefined;
    if (org) {
        const esc = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        t = t.replace(new RegExp(`\\s+${esc}$`, "i"), "").trim();
        if (normOrg(t) === normOrg(org))
            return undefined;
    }
    return t;
}
const REQ_PATTERNS = [
    [/\(ID:?\s*(\d{5,})\)/g, "(ID: n)"],
    [/\breq(?:uisition)?\.?\s*(?:#|no\.?|number|id)?\s*:?\s*#?\s*(\d{4,}[\w-]*)/gi, "req #"],
    [/\b(R\d{4}-\d{3,})\b/g, "requisition R####-n"],
    [/Reference Role:\s*(R\d{5,})/g, "reference role"],
    [/\|\s*#(\d{5,}(?:-\d+)?)\s*(?:\n|$)/g, "posting #"],
];
/** Title / requisition id / location of the specific job a record concerns (deterministic, first rule wins). */
export function jobIdentity(r, t) {
    const subj = decodeEntities(r.subject).replace(/^(?:(?:re|fwd?|fw|canceled|cancelled|updated invitation|invitation|accepted|declined):\s*)+/i, "").trim();
    const snippet = decodeEntities(r.snippet), body = decodeEntities(r.body, true);
    const text = `${subj}\n${snippet}\n${body}`;
    const out = {};
    const via = [];
    // Requisition: one distinct id across the record, else none (two ids = ambiguous, never guessed).
    for (const [re, name] of REQ_PATTERNS) {
        const ids = [...new Set([...text.matchAll(re)].map((m) => m[1].toUpperCase()))];
        if (ids.length === 1) {
            out.reqId = ids[0];
            via.push(`requisition by ${name}`);
            break;
        }
        if (ids.length > 1) {
            via.push(`${ids.length} different ids by ${name} — none used`);
            break;
        }
    }
    // Title, in order of reliability.
    const amz = /(?:position of|for the|interest in|application for(?: the)?(?: position of)?)\s+(.{3,160}?)\s*\(ID:?\s*\d{5,}\)/.exec(body) ?? /(?:position of|for the|interest in|application for(?: the)?(?: position of)?)\s+(.{3,160}?)\s*\(ID:?\s*\d{5,}\)/.exec(snippet);
    const candidates = [[amz?.[1], "title before the requisition id"], [t.title, `title from ${t.rule}`]];
    // LinkedIn cards: "<title>\n<company>\n<location>\nView job:" — the line before the company line is the title.
    // Only LinkedIn's own card layout (first line "Your application was sent to / viewed by …"); elsewhere the line before
    // the company name is usually a signature ("Best regards", "Beth Young").
    const lines = /^Your application was (?:sent to|viewed by)\b/i.test(body) ? body.split("\n").map((x) => x.trim()).slice(0, 6) : [];
    const isOrgLine = (x) => { const k = normOrg(x); return !!k && !!t.orgKey && (k === t.orgKey || k.startsWith(`${t.orgKey} `) || t.orgKey.startsWith(`${k} `)); };
    for (let i = 1; i < lines.length; i++) {
        if (/^view similar jobs/i.test(lines[i]))
            break;
        if (isOrgLine(lines[i]) && !/^(your application|your update|-{3})/i.test(lines[i - 1])) {
            candidates.push([lines[i - 1], "title line of the LinkedIn job card"]);
            const loc = lines[i + 1];
            if (loc && loc.length <= 60 && !/^(view job|-{3}|applied on)/i.test(loc) && /,|\barea\b|remote|hybrid|united states/i.test(loc))
                out.location = loc;
            break;
        }
    }
    const generic = /(?:application for|applying (?:to|for)|apply (?:to|for)|interest in|apply for)(?: the)? (?:position of )?(.{3,120}?) (?:position|role|opening|job)\b/i;
    candidates.push([generic.exec(snippet)?.[1], "title in the snippet"], [generic.exec(body)?.[1], "title in the body"]);
    const req = /application for req(?:uisition)?\.? ?#? ?\w[\w-]* (.{3,100}?)(?:\.\s|\.$|$)/im.exec(`${body}\n${snippet}`); // JHU "application for req #120088 Financial Analyst (DOM …)."
    candidates.push([req?.[1], "title after the requisition number"]);
    candidates.push([/Reference Role:\s*(.{3,140}?)\s*(?:\||$)/m.exec(body)?.[1], "reference role line"]); // Accenture
    const iv = / \/ [^/]*? - ([^/]{3,100})$/.exec(subj); // "Interview with Altarum / Julian … - Pricing Analyst"
    candidates.push([iv?.[1], "title after the candidate name in the subject"]);
    const inmail = /^(.{3,100}?) \| [^|]{3,80} \| [^|]{3,60} \| #\d/m.exec(body); // "Senior Staff Accountant | Political … | Annapolis, MD | #3572772-2"
    candidates.push([inmail?.[1], "title in a recruiter posting line"]);
    for (const [raw, how] of candidates) {
        const c = cleanTitle(raw, t.org);
        if (c) {
            out.title = c;
            via.push(how);
            break;
        }
    }
    if (via.length)
        out.via = via.join("; ");
    return out;
}
const ACTIVE = ["preparing", "applied", "interviewing", "offer"];
const TERMINAL = ["rejected", "withdrawn", "closed"];
const SHEET_RANK = { preparing: 1, applied: 2, interviewing: 3, offer: 4 };
function sheetInitial(rows) {
    const act = rows.filter((r) => SHEET_RANK[r.status]).sort((a, b) => SHEET_RANK[b.status] - SHEET_RANK[a.status])[0];
    if (act)
        return act.status;
    if (rows.length && rows.every((r) => TERMINAL.includes(r.status)))
        return [...rows.map((r) => r.status)].sort()[0];
    return "analyzed";
}
/** Per-JOB state machine. Terminal outcomes are final for THAT job: a new application elsewhere at the same employer is a
 *  different opportunity, and a later event on a closed job is recorded as an anomaly, never a reopen. */
function step(cur, k) {
    const terminal = TERMINAL.includes(cur);
    switch (k) {
        case "offer": return { next: "offer" };
        case "rejection": return { next: cur === "offer" ? "offer" : "rejected" };
        case "withdrawal": return { next: cur === "offer" ? "offer" : "withdrawn" };
        case "posting_closed": return { next: cur === "offer" || terminal ? cur : "closed" };
        case "interview":
        case "screen": return terminal ? { next: cur, anomaly: `${k} after ${cur}` } : { next: cur === "offer" ? "offer" : "interviewing" };
        case "application": return terminal ? { next: cur, anomaly: `application after ${cur}` } : { next: cur === "analyzed" || cur === "preparing" ? "applied" : cur };
        case "viewed": return { next: cur === "analyzed" || cur === "preparing" ? "applied" : cur };
        case "started": return { next: cur === "analyzed" ? "preparing" : cur };
    }
}
const ELIGIBLE = (e) => !e || /no restriction/i.test(e);
const FOLLOWUP_DAYS = 7;
const RECRUITER_NAME = /\b(recruit\w*|staffing|talent|search|headhunt\w*|placement|personnel|consultants?|solutions group)\b|^(kforce|vaco|korn ferry|addison group|robert half|insight global|teksystems)\b/i;
const OUR_CLIENT = /\b(our client|on behalf of (?:our|a) client|confidential client)\b/i;
export function interpretCareer(s, opts = {}) {
    const asOf = (opts.asOf ?? s.acquiredAt).slice(0, 10);
    const sheet = s.sheet.ok && s.sheet.csv ? extractSheet(s.sheet.csv) : { rows: [], dropped: 0, duplicates: 0 };
    const records = evidenceRecords(s);
    const byId = new Map(records.map((r) => [`${r.account}|${r.id}`, r]));
    const sheetKeys = sheet.rows.map((r) => normOrg(r.org)).filter(Boolean);
    const known = new Set(sheetKeys);
    for (const t of records.map((r) => classifyRecord(r, known)))
        if (t.orgKey)
            known.add(t.orgKey);
    const traces = records.map((r) => classifyRecord(r, known));
    const canon = resolveAliases([...sheetKeys, ...traces.flatMap((t) => (t.orgKey ? [t.orgKey] : []))]);
    const aliasesOf = (k) => [...canon.entries()].filter(([, c]) => c === k).map(([a]) => a).sort(cmp);
    const evByEmp = new Map();
    traces.forEach((t, i) => { if (t.stage === "candidate" && t.orgKey) {
        const k = canon.get(t.orgKey);
        evByEmp.set(k, [...(evByEmp.get(k) ?? []), { t, rec: records[i] }]);
    } });
    const rowsByEmp = new Map();
    for (const r of sheet.rows) {
        const k = canon.get(normOrg(r.org));
        if (k)
            rowsByEmp.set(k, [...(rowsByEmp.get(k) ?? []), r]);
    }
    const opportunities = [];
    const employers = [];
    const unassigned = [];
    const conflicts = [];
    const lag = [];
    const linkedRows = new Set();
    for (const emp of [...evByEmp.keys()].sort(cmp)) {
        const evs = evByEmp.get(emp); // total order (records were sorted)
        const rows = rowsByEmp.get(emp) ?? [];
        const freq = new Map();
        for (const e of evs)
            freq.set(e.t.org, (freq.get(e.t.org) ?? 0) + 2);
        for (const r of rows)
            freq.set(r.org, (freq.get(r.org) ?? 0) + 1);
        const empName = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || cmp(a[0], b[0]))[0][0];
        const groups = new Map();
        const group = (key, init) => groups.get(key) ?? groups.set(key, { key, ...init, evs: [], aliases: new Set([key]) }).get(key);
        const titleToReq = new Map();
        for (const e of evs)
            if (e.t.reqId && e.t.title) {
                const nt = normTitle(e.t.title);
                titleToReq.set(nt, (titleToReq.get(nt) ?? new Set()).add(e.t.reqId));
            }
        const locsByTitle = new Map();
        for (const e of evs)
            if (!e.t.reqId && e.t.title && e.t.location) {
                const nt = normTitle(e.t.title);
                locsByTitle.set(nt, (locsByTitle.get(nt) ?? new Set()).add(normLoc(e.t.location)));
            }
        const bare = [];
        for (const e of evs) {
            if (e.t.reqId) {
                const g = group(`job:${emp}|req:${e.t.reqId.toLowerCase()}`, { basis: "requisition", reqId: e.t.reqId, title: e.t.title ?? null, location: e.t.location ?? null });
                if (!g.title && e.t.title)
                    g.title = e.t.title;
                if (e.t.title)
                    g.aliases.add(`job:${emp}|title:${normTitle(e.t.title)}`);
                g.evs.push(e);
                continue;
            }
            if (e.t.title) {
                const nt = normTitle(e.t.title);
                const reqs = [...(titleToReq.get(nt) ?? [])].sort(cmp);
                if (reqs.length === 1) {
                    group(`job:${emp}|req:${reqs[0].toLowerCase()}`, { basis: "requisition", reqId: reqs[0], title: e.t.title, location: null }).evs.push(e);
                    continue;
                }
                if (reqs.length > 1) {
                    unassigned.push({ employerKey: emp, employer: empName, recordId: e.rec.id, at: e.rec.at, kind: e.t.kind, subject: decodeEntities(e.rec.subject).slice(0, 120), reason: `title "${e.t.title}" matches ${reqs.length} requisitions (${reqs.join(", ")}) and the record names none` });
                    continue;
                }
                const multiLoc = (locsByTitle.get(nt)?.size ?? 0) > 1;
                if (multiLoc && !e.t.location) {
                    unassigned.push({ employerKey: emp, employer: empName, recordId: e.rec.id, at: e.rec.at, kind: e.t.kind, subject: decodeEntities(e.rec.subject).slice(0, 120), reason: `"${e.t.title}" exists at several locations and the record names none` });
                    continue;
                }
                const key = multiLoc ? `job:${emp}|title:${nt}|loc:${normLoc(e.t.location)}` : `job:${emp}|title:${nt}`;
                const g = group(key, { basis: multiLoc ? "title+location" : "title", reqId: null, title: e.t.title, location: e.t.location ?? null });
                if (!g.location && e.t.location)
                    g.location = e.t.location;
                g.evs.push(e);
                continue;
            }
            bare.push(e);
        }
        // 2) events that name no job: attach only when the employer has exactly one job in evidence (or one sheet row)
        for (const e of bare) {
            const gs = [...groups.values()];
            let target = null;
            let why = "";
            if (gs.length === 1) {
                target = gs[0];
                why = "the employer's only job in evidence";
            }
            else if (gs.length === 0 && rows.length === 1) {
                target = group(`job:${emp}|title:${normTitle(rows[0].title)}`, { basis: "sheet-row", reqId: null, title: rows[0].title, location: rows[0].location });
                why = "the employer's only Career Copilot row";
            }
            else if (gs.length === 0) {
                target = group(`job:${emp}|role:unknown`, { basis: "employer-only", reqId: null, title: null, location: null });
                why = "no role named anywhere for this employer";
            }
            if (target) {
                target.evs.push(e);
                if (target.basis !== "employer-only")
                    target.aliases.add(`job:${emp}|role:unknown`);
                void why;
            }
            else
                unassigned.push({ employerKey: emp, employer: empName, recordId: e.rec.id, at: e.rec.at, kind: e.t.kind, subject: decodeEntities(e.rec.subject).slice(0, 120), reason: `the employer has ${gs.length} jobs in evidence and this record names none` });
        }
        // 3) link Career Copilot rows by exact normalized title (a row matching several jobs is linked to none)
        const rowLinks = new Map();
        for (const r of rows) {
            const nt = normTitle(r.title);
            const hits = [...groups.values()].filter((g) => (g.title && normTitle(g.title) === nt) || g.evs.some((e) => e.t.title && normTitle(e.t.title) === nt));
            if (hits.length === 1) {
                rowLinks.set(hits[0].key, [...(rowLinks.get(hits[0].key) ?? []), r]);
                linkedRows.add(r.sourceId);
            }
            else if (hits.length > 1)
                conflicts.push(`${empName}: sheet row ${r.sourceId} "${r.title}" matches ${hits.length} jobs in evidence (${hits.map((h) => h.reqId ?? h.title).join(", ")}) — not linked`);
        }
        // 4) per-job state, history, contact, dates
        const empOpps = [];
        for (const g of [...groups.values()].sort((a, b) => cmp(a.key, b.key))) {
            g.evs.sort((a, b) => cmp(a.rec.at, b.rec.at) || cmp(a.rec.id, b.rec.id));
            const linked = rowLinks.get(g.key) ?? [];
            let st = sheetInitial(linked);
            const events = [];
            const anomalies = [];
            for (const { rec, t } of g.evs) {
                const before = st;
                const r2 = step(st, t.kind);
                st = r2.next;
                if (r2.anomaly)
                    anomalies.push(`${rec.at.slice(0, 10)} ${r2.anomaly} (record ${rec.id})`);
                events.push({ recordId: rec.id, at: rec.at, kind: t.kind, rule: t.rule ?? "", transition: `${before}→${st}`, subject: decodeEntities(rec.subject).slice(0, 120) });
            }
            const titles = g.evs.flatMap((e) => (e.t.title ? [e.t.title] : []));
            const tf = new Map();
            for (const x of titles)
                tf.set(x, (tf.get(x) ?? 0) + 1);
            const title = [...tf.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || cmp(a[0], b[0]))[0]?.[0] ?? g.title ?? linked[0]?.title ?? null;
            const contactRec = g.evs.map((e) => e.rec).filter((r) => r.source === "gmail" && r.from && !/no-?reply|linkedin|lever|workable|greenhouse|otter|julian|correounivalle|myworkday|icims|successfactors/i.test(r.from)).pop();
            const contact = contactRec ? (/^"?([^"<]+?)"?\s*</.exec(contactRec.from)?.[1]?.trim() ?? null) : null;
            const last = g.evs.length ? g.evs[g.evs.length - 1].rec.at : null;
            const first = g.evs.length ? g.evs[0].rec.at : null;
            const appliedAt = g.evs.find((e) => e.t.kind === "application" || e.t.kind === "viewed")?.rec.at ?? null;
            const due = last ? new Date(Date.parse(last.slice(0, 10)) + FOLLOWUP_DAYS * 86_400_000).toISOString().slice(0, 10) : null;
            const active = ACTIVE.includes(st);
            const sheetStatus = linked.length ? [...new Set(linked.map((r) => r.status))].sort(cmp).join(",") : null;
            if (linked.length && sheetInitial(linked) !== st)
                lag.push(`${empName} — ${title ?? "?"} (sheet "${sheetStatus}" → evidence "${st}")`);
            for (const r of linked) {
                g.aliases.add(`sheet:${r.sourceId}`);
                g.aliases.add(dedupeKey(r.org, r.title, r.url));
            }
            const opp = {
                key: g.key, aliasKeys: [...g.aliases].sort(cmp), employerKey: emp, employer: empName, title, reqId: g.reqId, location: g.location ?? linked[0]?.location ?? null, identityBasis: g.basis,
                status: st, events, anomalies, sheetRows: linked.map((r) => r.sourceId).sort(cmp), sheetStatus, contact, firstEvidenceAt: first, lastEvidenceAt: last, appliedAt,
                followupDue: active ? due : null, followup: active && due && due <= asOf ? `Follow up with ${contact ?? empName} on ${title ?? "the application"} — last evidence ${last.slice(0, 10)}, follow-up due ${due}` : null,
                sourceIds: [...g.evs.map((e) => `${e.rec.source}:${e.rec.id}`), ...linked.map((r) => `sheet:${r.sourceId}`)].sort(cmp),
            };
            opportunities.push(opp);
            empOpps.push(opp.key);
            for (const a of anomalies)
                conflicts.push(`${empName} — ${title ?? "?"}: ${a}`);
        }
        // 5) employer as a shared entity; recruiter/job-board labels come from the evidence, never renamed
        const bodies = evs.map((e) => `${decodeEntities(e.rec.snippet)} ${decodeEntities(e.rec.body)}`).join(" ");
        const party = OUR_CLIENT.test(bodies) ? "recruiter_or_staffing" : /\bjobs?$/i.test(empName) ? "job_board_or_recruiter" : RECRUITER_NAME.test(empName) ? "recruiter_or_staffing" : "employer";
        const partyReason = OUR_CLIENT.test(bodies) ? `evidence says "${OUR_CLIENT.exec(bodies)[0]}"` : party === "employer" ? "named as the hiring company in the evidence; no recruiter signals" : `name "${empName}" is a staffing/job-board name`;
        employers.push({ key: emp, name: empName, aliases: aliasesOf(emp), party, partyReason, opportunityKeys: empOpps });
    }
    if (lag.length)
        conflicts.push(`Career Copilot sheet lags the email evidence for ${lag.length} job(s): ${lag.join("; ")}`);
    if (unassigned.length)
        conflicts.push(`${unassigned.length} employer event(s) name no specific job and the employer has several — kept unassigned (no status changed): ${unassigned.map((u) => `${u.employer} ${u.at.slice(0, 10)} ${u.kind}`).join("; ")}`);
    opportunities.sort((a, b) => cmp(a.key, b.key));
    // Identity safety: an alias shared by two jobs (e.g. one title, two requisitions) identifies neither — drop it from
    // both, so no stored job can ever be matched to (and merged with) another one.
    const aliasUse = new Map();
    for (const o of opportunities)
        for (const k of o.aliasKeys)
            aliasUse.set(k, (aliasUse.get(k) ?? 0) + 1);
    for (const o of opportunities)
        o.aliasKeys = o.aliasKeys.filter((k) => k === o.key || aliasUse.get(k) === 1);
    const active = opportunities.filter((o) => ACTIVE.includes(o.status));
    const closed = opportunities.filter((o) => !ACTIVE.includes(o.status) && o.status !== "analyzed");
    const byStatus = {};
    for (const r of sheet.rows)
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    // Shortlist: postings NOT already linked to a job with evidence (other roles at the same employer stay eligible).
    const shortlist = sheet.rows.filter((r) => r.status === "analyzed" && !linkedRows.has(r.sourceId) && (r.fitScore ?? 0) >= 88 && ELIGIBLE(r.eligibility))
        .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || cmp(a.org, b.org) || cmp(a.title, b.title) || cmp(a.sourceId, b.sourceId)).slice(0, 10)
        .map((r) => ({ org: r.org, title: r.title, score: r.fitScore, eligibility: r.eligibility }));
    const ineligible = sheet.rows.filter((r) => !ELIGIBLE(r.eligibility)).length;
    if (ineligible)
        conflicts.push(`${ineligible} sheet posting(s) list citizenship/clearance requirements — kept, excluded from the shortlist`);
    if (!s.completeness.complete)
        conflicts.push(`INCOMPLETE SNAPSHOT — ${s.completeness.problems.join("; ")}`);
    void byId;
    const counts = { records: records.length, excluded: traces.filter((t) => t.stage === "excluded").length, unclassified: traces.filter((t) => t.stage === "unclassified").length,
        unparsed: traces.filter((t) => t.stage === "unparsed").length, candidates: traces.filter((t) => t.stage === "candidate").length, opportunities: opportunities.length, unassigned: unassigned.length };
    return { interpreterVersion: INTERPRETER_VERSION, snapshotDigest: snapshotDigest(s), acquiredAt: s.acquiredAt, asOf, complete: s.completeness.complete, problems: s.completeness.problems,
        opportunities, employers, unassigned, active, closed, conflicts: conflicts.sort(cmp),
        pipeline: { total: sheet.rows.length, byStatus, shortlist, sheetRows: sheet.rows.length, dropped: sheet.dropped, duplicates: sheet.duplicates },
        traces: { records: traces }, counts };
}
/** Digest of everything decision-relevant: job set, statuses, event histories, evidence links, conflicts, shortlist, follow-ups. */
export function interpretationDigest(i) {
    return sha(canonical({ v: i.interpreterVersion, asOf: i.asOf, opportunities: i.opportunities, employers: i.employers, unassigned: i.unassigned, conflicts: i.conflicts, pipeline: i.pipeline })).slice(0, 16);
}
/** The job set and statuses only (what must not move without new evidence). */
export function opportunitySetDigest(i) {
    return sha(canonical(i.opportunities.map((o) => [o.key, o.status]))).slice(0, 16);
}
/** Employer-level trace: every record that mentions it → stage/kind/rule/job identity → the job it joined (or why none). */
export function traceOrg(s, i, name) {
    const needle = normOrg(name);
    const recs = evidenceRecords(s);
    const mentions = recs.filter((r) => normOrg(`${decodeEntities(r.subject)} ${decodeEntities(r.snippet)} ${r.from}`).includes(needle));
    const traceById = new Map(i.traces.records.map((t) => [`${t.account}|${t.recordId}`, t]));
    const emp = i.employers.find((e) => e.aliases.some((a) => a === needle || a.startsWith(`${needle} `) || needle.startsWith(`${a} `)));
    const opps = emp ? i.opportunities.filter((o) => o.employerKey === emp.key) : [];
    const jobOf = new Map(opps.flatMap((o) => o.events.map((e) => [e.recordId, o.key])));
    const un = new Map(i.unassigned.map((u) => [u.recordId, u.reason]));
    const sheetRows = s.sheet.ok && s.sheet.csv ? extractSheet(s.sheet.csv).rows.filter((r) => normOrg(r.org).includes(needle)).map((r) => ({ id: r.sourceId, org: r.org, title: r.title, status: r.status })) : [];
    return {
        name, snapshotDigest: snapshotDigest(s), interpreterVersion: i.interpreterVersion, employer: emp ?? null,
        found: mentions.map((r) => {
            const t = traceById.get(`${r.account}|${r.id}`);
            return { recordId: r.id, account: r.account, at: r.at, subject: decodeEntities(r.subject).slice(0, 120), from: r.from, acquiredVia: r.queries,
                stage: t.stage, kind: t.kind ?? null, rule: t.rule ?? null, extractedOrg: t.org ?? null, title: t.title ?? null, reqId: t.reqId ?? null, location: t.location ?? null, jobVia: t.jobVia ?? null,
                job: jobOf.get(r.id) ?? null, unassignedReason: un.get(r.id) ?? null, reason: t.reason };
        }),
        sheetRows,
        jobs: opps.map((o) => ({ key: o.key, title: o.title, reqId: o.reqId, location: o.location, basis: o.identityBasis, status: o.status, sheetRows: o.sheetRows,
            events: o.events.map((e) => `${e.at.slice(0, 10)} ${e.kind} ${e.transition} [${e.recordId}]`), anomalies: o.anomalies })),
    };
}
/** Record-level delta between two snapshots and which records explain each JOB change (matched by any alias key). */
export function snapshotDelta(prev, cur, opts = {}) {
    const k = (r) => `${r.source}|${r.account}|${r.id}`;
    const a = new Map(evidenceRecords(prev).map((r) => [k(r), r])), b = new Map(evidenceRecords(cur).map((r) => [k(r), r]));
    const missingReason = new Map((cur.carryForward ?? []).flatMap((c) => c.missing.map((m) => [`gmail|${c.account}|${m.id}`, m.reason])));
    const added = [...b.keys()].filter((x) => !a.has(x)).sort(cmp).map((x) => b.get(x));
    const removed = [...a.keys()].filter((x) => !b.has(x)).sort(cmp).map((x) => a.get(x));
    const ip = interpretCareer(prev, opts.asOfPrev ? { asOf: opts.asOfPrev } : {}), ic = interpretCareer(cur, opts.asOfCur ? { asOf: opts.asOfCur } : {});
    const rowsP = new Map((prev.sheet.csv ? extractSheet(prev.sheet.csv).rows : []).map((r) => [r.sourceId, r])), rowsC = new Map((cur.sheet.csv ? extractSheet(cur.sheet.csv).rows : []).map((r) => [r.sourceId, r]));
    const rowsAdded = [...rowsC.keys()].filter((x) => !rowsP.has(x)).sort(cmp), rowsRemoved = [...rowsP.keys()].filter((x) => !rowsC.has(x)).sort(cmp);
    const rowStatus = [...rowsC.keys()].filter((x) => rowsP.has(x) && rowsP.get(x).status !== rowsC.get(x).status).sort(cmp).map((x) => ({ id: x, from: rowsP.get(x).status, to: rowsC.get(x).status }));
    const changedRows = new Set([...rowsAdded, ...rowsRemoved, ...rowStatus.map((r) => r.id)]);
    const addedIds = new Set(added.map((r) => r.id)), removedIds = new Set(removed.map((r) => r.id));
    const label = (o) => `${o.employer} — ${o.title ?? o.reqId ?? "role unknown"}`;
    const match = (o, set) => set.find((x) => x.aliasKeys.some((al) => o.aliasKeys.includes(al)));
    const why = (o, ids) => [...o.events.map((e) => e.recordId).filter((id) => ids.has(id)), ...o.sheetRows.filter((r) => changedRows.has(r)).map((r) => `sheet:${r}`)];
    const isActive = (st) => ACTIVE.includes(st);
    const P = ip.opportunities, C = ic.opportunities;
    const oppAdded = C.filter((o) => isActive(o.status) && !(match(o, P) && isActive(match(o, P).status))).map((o) => ({ org: label(o), explainedBy: why(o, addedIds) }));
    const oppRemoved = P.filter((o) => isActive(o.status) && !(match(o, C) && isActive(match(o, C).status))).map((o) => {
        const now = match(o, C);
        return { org: label(o), becameStatus: now?.status ?? null, explainedBy: [...why(o, removedIds), ...(now ? why(now, addedIds) : [])] };
    });
    const statusChanged = C.filter((o) => { const p = match(o, P); return p && p.status !== o.status && isActive(p.status) === isActive(o.status); })
        .map((o) => ({ org: label(o), from: match(o, P).status, to: o.status, explainedBy: why(o, addedIds) }));
    // A job that existed before must still exist (any status) — disappearance is only explainable by removed records.
    const vanished = P.filter((o) => !match(o, C)).map((o) => ({ org: label(o), becameStatus: null, explainedBy: why(o, removedIds) })).filter((v) => !oppRemoved.some((r) => r.org === v.org));
    const dueP = new Set(ip.active.filter((o) => o.followup).map((o) => o.key));
    const followupsDue = ic.active.filter((o) => o.followup && !dueP.has(o.key)).map((o) => `${label(o)} (due ${o.followupDue})`);
    const unexplained = [...oppAdded, ...oppRemoved, ...vanished, ...statusChanged].filter((o) => !o.explainedBy.length).map((o) => o.org);
    return {
        sameInput: snapshotDigest(prev) === snapshotDigest(cur), sameOutput: interpretationDigest(ip) === interpretationDigest(ic), sameOpportunitySet: opportunitySetDigest(ip) === opportunitySetDigest(ic),
        addedRecords: added.map((r) => ({ id: r.id, account: r.account, at: r.at, subject: decodeEntities(r.subject).slice(0, 100) })),
        removedRecords: removed.map((r) => ({ id: r.id, account: r.account, at: r.at, subject: decodeEntities(r.subject).slice(0, 100), reason: missingReason.get(k(r)) ?? "not returned by any query and not re-verified" })),
        sheet: { changed: (prev.sheet.sha256 ?? null) !== (cur.sheet.sha256 ?? null), rowsAdded, rowsRemoved, statusChanged: rowStatus },
        oppAdded, oppRemoved: [...oppRemoved, ...vanished], statusChanged, followupsDue, unexplained,
    };
}
//# sourceMappingURL=career-evidence.js.map