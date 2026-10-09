export const STATUS_RANK = {
    discovered: 0, analyzed: 0, shortlisted: 1, preparing: 2, ready_for_review: 3, applied: 4, interviewing: 5, offer: 6, rejected: 7, withdrawn: 7, closed: 7,
};
export const TERMINAL_STATUSES = ["rejected", "withdrawn", "closed"];
export const isTerminal = (s) => TERMINAL_STATUSES.includes(s);
export const isStatus = (s) => s in STATUS_RANK;
/** May `next` replace `cur`? Forward only; terminal is final; an offer is never overwritten by a later rejection notice. */
export function transitionAllowed(cur, next) {
    if (!isStatus(next) || !isStatus(cur) || cur === next)
        return { ok: false };
    if (isTerminal(cur))
        return { ok: false, anomaly: `${next} reported after the job was ${cur} (a terminal outcome is never reopened)` };
    if (cur === "offer" && isTerminal(next))
        return { ok: next === "withdrawn" }; // Julian may decline an offer; an automated rejection can't undo it
    return { ok: STATUS_RANK[next] > STATUS_RANK[cur] };
}
export const CAREER_POLICY = { responseDays: 14, interviewDecisionDays: 7, staleAppliedDays: 30, julianActionDays: 3 };
export const NEEDS_JULIAN = ["principal_reserved", "judgment", "authorization"];
const DAY = 86_400_000;
const day = (iso) => Date.parse(iso.slice(0, 10));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
export const jobName = (j) => `${j.employer} — ${j.title ?? "role not named"}${j.reqId ? ` (${j.reqId})` : ""}`;
/** The single next step for one job, given its facts and the date. Deterministic. */
export function nextStepFor(j, now, p = CAREER_POLICY) {
    const today = day(now.toISOString());
    const role = j.title ? `the ${j.title} role` : "the application";
    const who = j.contact ?? j.employer;
    const lastContact = j.lastEvidenceAt ?? j.appliedAt ?? j.createdAt;
    const since = Math.max(0, Math.floor((today - day(lastContact)) / DAY));
    const julianDue = ymd(today + p.julianActionDays * DAY);
    switch (j.status) {
        case "rejected":
        case "withdrawn":
        case "closed":
            return { kind: "close", rule: `${j.status}.close`, outcome: `${jobName(j)}: ${j.status}${j.lastEvidenceAt ? ` (${j.lastEvidenceAt.slice(0, 10)})` : ""}`, reason: `the job is ${j.status}; nothing is waiting on it any more` };
        case "offer":
            return { kind: "action", rule: "offer.respond", owner: "julian", state: "open", summary: `Respond to the ${j.employer} offer for ${role}`, counterparty: who, due: julianDue, reason: "an offer needs your answer",
                needsJulian: { kind: "judgment", because: "accepting, negotiating or declining an offer is your decision" } };
        case "interviewing": {
            const last = j.lastInterviewAt && day(j.lastInterviewAt) > day(lastContact) ? j.lastInterviewAt : lastContact;
            const decideBy = day(last) + p.interviewDecisionDays * DAY;
            if (today < decideBy)
                return { kind: "action", rule: "interviewing.awaiting_decision", owner: "finagai", state: "waiting", summary: `Waiting on ${who} for the next step on ${role} at ${j.employer}`, counterparty: who,
                    due: ymd(decideBy), reason: `last contact ${last.slice(0, 10)}; employers usually answer within ${p.interviewDecisionDays} days` };
            return { kind: "action", rule: "interviewing.nudge", owner: "julian", state: "open", summary: `Approve a follow-up to ${who} on ${role} at ${j.employer} — no news since ${last.slice(0, 10)} (Finagai drafts it; sending as you is yours)`, counterparty: who,
                due: julianDue, reason: `${Math.floor((today - day(last)) / DAY)} days without news after an interview`,
                needsJulian: { kind: "principal_reserved", because: "a message to the employer goes out as you" } };
        }
        case "applied": {
            const answerBy = day(lastContact) + p.responseDays * DAY;
            if (today < answerBy)
                return { kind: "action", rule: "applied.awaiting_response", owner: "finagai", state: "waiting", summary: `Waiting on ${j.employer} to respond to the ${j.title ?? ""} application`.replace(/\s+/g, " "), counterparty: who,
                    due: ymd(answerBy), reason: `last contact ${lastContact.slice(0, 10)}; no answer by ${ymd(answerBy)} ${j.contact ? `becomes your decision (nudge ${j.contact} or let it ride)` : "closes the project quietly (no named contact to nudge); the job stays in the pipeline"}` };
            // Silence. A person to nudge makes it Julian's decision (until it goes stale); no person = nothing useful to do,
            // so the job quietly leaves the active list and stays in the pipeline (any new evidence brings it back).
            if (j.contact && since < p.staleAppliedDays)
                return { kind: "action", rule: "applied.nudge_or_let_go", owner: "julian", state: "open", summary: `Approve a follow-up to ${j.contact} about ${role} at ${j.employer}, or let it ride — no response for ${since} days (Finagai drafts it; sending as you is yours)`, counterparty: j.contact,
                    due: julianDue, reason: `${since} days without a response (≥ ${p.responseDays}); it leaves the active list after ${p.staleAppliedDays} days`,
                    needsJulian: { kind: "principal_reserved", because: "a message to the employer goes out as you" } };
            return { kind: "close", rule: "applied.no_response", outcome: `${jobName(j)}: no response ${since} days after the last contact${j.contact ? "" : " and no contact to nudge"} — kept in the pipeline as applied; new evidence reopens it`,
                reason: j.contact ? `no response for ${since} days (≥ ${p.staleAppliedDays})` : `no response for ${since} days (≥ ${p.responseDays}) and no named contact to follow up with` };
        }
        case "preparing":
        case "ready_for_review":
            // An application started long ago and never submitted (live: Amazon 10461970, started 8/10) is not a live task.
            if (since >= p.staleAppliedDays)
                return { kind: "close", rule: "preparing.abandoned", outcome: `${jobName(j)}: started ${since} days ago and never submitted — kept in the pipeline`, reason: `no activity for ${since} days (≥ ${p.staleAppliedDays}) on an unsubmitted application` };
            return { kind: "action", rule: "preparing.submit", owner: "julian", state: "open", summary: `Submit the ${j.employer} application for ${role} (Finagai prepares and fills it; submitting is yours)`, counterparty: "Julian",
                due: julianDue, reason: "the application is being prepared; only you submit",
                needsJulian: { kind: "principal_reserved", because: "submitting an application is reserved to you" } };
        default:
            return { kind: "none", rule: `${j.status}.pipeline`, reason: "pipeline record only (not engaged): no project, no next action" };
    }
}
/** A job deserves a project exactly when it has a next step (and is not being closed). */
export const needsProject = (s) => s.kind === "action";
//# sourceMappingURL=lifecycle.js.map