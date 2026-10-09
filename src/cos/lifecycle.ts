/**
 * Phase 4 (ADR-082) — the opportunity lifecycle policy. PURE: no database, no clock (now is passed in).
 *
 * Every job opportunity Julian is engaged with has exactly one owner of its next step at any time:
 *   - Julian      (finish and submit an application, decide whether to nudge a silent employer, answer an offer), or
 *   - the counterparty (we are waiting for the employer's response, with a date by which silence becomes a decision).
 * Terminal outcomes (rejected / withdrawn / closed) end the job's project; nothing is left "waiting" on a closed job.
 *
 * Status only moves FORWARD (rank order). A terminal job never reopens: a later event on it is an anomaly for Julian.
 * The policy numbers are per-area data (CAREER_POLICY), not code paths, so other opportunity kinds reuse the engine.
 */
export type OppStatus = "discovered" | "analyzed" | "shortlisted" | "preparing" | "ready_for_review" | "applied" | "interviewing" | "offer" | "rejected" | "withdrawn" | "closed";

export const STATUS_RANK: Record<OppStatus, number> = {
  discovered: 0, analyzed: 0, shortlisted: 1, preparing: 2, ready_for_review: 3, applied: 4, interviewing: 5, offer: 6, rejected: 7, withdrawn: 7, closed: 7,
};
export const TERMINAL_STATUSES: OppStatus[] = ["rejected", "withdrawn", "closed"];
export const isTerminal = (s: string) => (TERMINAL_STATUSES as string[]).includes(s);
export const isStatus = (s: string): s is OppStatus => s in STATUS_RANK;

/** May `next` replace `cur`? Forward only; terminal is final; an offer is never overwritten by a later rejection notice. */
export function transitionAllowed(cur: string, next: string): { ok: boolean; anomaly?: string } {
  if (!isStatus(next) || !isStatus(cur) || cur === next) return { ok: false };
  if (isTerminal(cur)) return { ok: false, anomaly: `${next} reported after the job was ${cur} (a terminal outcome is never reopened)` };
  if (cur === "offer" && isTerminal(next)) return { ok: next === "withdrawn" };   // Julian may decline an offer; an automated rejection can't undo it
  return { ok: STATUS_RANK[next] > STATUS_RANK[cur] };
}

export interface LifecyclePolicy {
  /** Days after the last employer contact before a silent application becomes Julian's decision. */
  responseDays: number;
  /** Days after the last interview/screen contact before a silent interview process becomes Julian's decision. */
  interviewDecisionDays: number;
  /** Days after which an unanswered application leaves the active projects (it stays in the pipeline as applied). */
  staleAppliedDays: number;
  /** Days Julian gets for his own actions (finish an application, decide on a nudge, answer an offer). */
  julianActionDays: number;
}
export const CAREER_POLICY: LifecyclePolicy = { responseDays: 14, interviewDecisionDays: 7, staleAppliedDays: 30, julianActionDays: 3 };

export interface JobFacts {
  employer: string; title: string | null; reqId: string | null; status: string; contact: string | null;
  appliedAt: string | null; lastEvidenceAt: string | null; lastInterviewAt: string | null; createdAt: string;
}

export type NextStep =
  | { kind: "action"; rule: string; owner: "julian" | "counterparty"; state: "open" | "waiting"; summary: string; counterparty: string; due: string; reason: string }
  | { kind: "close"; rule: string; outcome: string; reason: string }
  | { kind: "none"; rule: string; reason: string };

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(iso.slice(0, 10));
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const jobName = (j: { employer: string; title: string | null; reqId: string | null }) => `${j.employer} — ${j.title ?? "role not named"}${j.reqId ? ` (${j.reqId})` : ""}`;

/** The single next step for one job, given its facts and the date. Deterministic. */
export function nextStepFor(j: JobFacts, now: Date, p: LifecyclePolicy = CAREER_POLICY): NextStep {
  const today = day(now.toISOString());
  const role = j.title ? `the ${j.title} role` : "the application";
  const who = j.contact ?? j.employer;
  const lastContact = j.lastEvidenceAt ?? j.appliedAt ?? j.createdAt;
  const since = Math.max(0, Math.floor((today - day(lastContact)) / DAY));
  const julianDue = ymd(today + p.julianActionDays * DAY);
  switch (j.status) {
    case "rejected": case "withdrawn": case "closed":
      return { kind: "close", rule: `${j.status}.close`, outcome: `${jobName(j)}: ${j.status}${j.lastEvidenceAt ? ` (${j.lastEvidenceAt.slice(0, 10)})` : ""}`, reason: `the job is ${j.status}; nothing is waiting on it any more` };
    case "offer":
      return { kind: "action", rule: "offer.respond", owner: "julian", state: "open", summary: `Respond to the ${j.employer} offer for ${role}`, counterparty: who, due: julianDue, reason: "an offer needs your answer" };
    case "interviewing": {
      const last = j.lastInterviewAt && day(j.lastInterviewAt) > day(lastContact) ? j.lastInterviewAt : lastContact;
      const decideBy = day(last) + p.interviewDecisionDays * DAY;
      if (today < decideBy)
        return { kind: "action", rule: "interviewing.awaiting_decision", owner: "counterparty", state: "waiting", summary: `Waiting on ${who} for the next step on ${role} at ${j.employer}`, counterparty: who,
          due: ymd(decideBy), reason: `last contact ${last.slice(0, 10)}; employers usually answer within ${p.interviewDecisionDays} days` };
      return { kind: "action", rule: "interviewing.nudge", owner: "julian", state: "open", summary: `Follow up with ${who} on ${role} at ${j.employer} — no news since ${last.slice(0, 10)}`, counterparty: who,
        due: julianDue, reason: `${Math.floor((today - day(last)) / DAY)} days without news after an interview; a short follow-up is yours to send (Finagai can draft it)` };
    }
    case "applied": {
      const answerBy = day(lastContact) + p.responseDays * DAY;
      if (today < answerBy)
        return { kind: "action", rule: "applied.awaiting_response", owner: "counterparty", state: "waiting", summary: `Waiting on ${j.employer} to respond to the ${j.title ?? ""} application`.replace(/\s+/g, " "), counterparty: who,
          due: ymd(answerBy), reason: `last contact ${lastContact.slice(0, 10)}; no answer by ${ymd(answerBy)} ${j.contact ? `becomes your decision (nudge ${j.contact} or let it ride)` : "closes the project quietly (no named contact to nudge); the job stays in the pipeline"}` };
      // Silence. A person to nudge makes it Julian's decision (until it goes stale); no person = nothing useful to do,
      // so the job quietly leaves the active list and stays in the pipeline (any new evidence brings it back).
      if (j.contact && since < p.staleAppliedDays)
        return { kind: "action", rule: "applied.nudge_or_let_go", owner: "julian", state: "open", summary: `Decide: nudge ${j.contact} about ${role} at ${j.employer}, or let it ride (no response for ${since} days)`, counterparty: j.contact,
          due: julianDue, reason: `${since} days without a response (≥ ${p.responseDays}); it leaves the active list after ${p.staleAppliedDays} days` };
      return { kind: "close", rule: "applied.no_response", outcome: `${jobName(j)}: no response ${since} days after the last contact${j.contact ? "" : " and no contact to nudge"} — kept in the pipeline as applied; new evidence reopens it`,
        reason: j.contact ? `no response for ${since} days (≥ ${p.staleAppliedDays})` : `no response for ${since} days (≥ ${p.responseDays}) and no named contact to follow up with` };
    }
    case "preparing": case "ready_for_review":
      return { kind: "action", rule: "preparing.submit", owner: "julian", state: "open", summary: `Finish and submit the ${j.employer} application for ${role} (submitting is yours)`, counterparty: "Julian",
        due: julianDue, reason: "the application is being prepared; only you submit" };
    default:
      return { kind: "none", rule: `${j.status}.pipeline`, reason: "pipeline record only (not engaged): no project, no next action" };
  }
}

/** A job deserves a project exactly when it has a next step (and is not being closed). */
export const needsProject = (s: NextStep) => s.kind === "action";
