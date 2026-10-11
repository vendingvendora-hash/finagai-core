/**
 * Phase 6 (ADR-085, revised): time-to-answer with CENSORING. An application that has not been answered yet is not a
 * missing data point — it is known to have waited at least as long as it has been open. Dropping it (the first
 * version did) keeps only the outcomes that happened, which biases response times DOWN. Kaplan–Meier uses every
 * application: answered ones are events at their answer time, unanswered ones are censored at their follow-up time.
 * Pure functions; no database.
 */
/** Kaplan–Meier product-limit estimate of S(t) = P(no answer by t). Censorings tied with events stay at risk. */
export function kaplanMeier(obs) {
    const xs = obs.filter((o) => Number.isFinite(o.t) && o.t >= 0).sort((a, b) => a.t - b.t || Number(b.event) - Number(a.event));
    const steps = [];
    let atRisk = xs.length, S = 1, varSum = 0, i = 0;
    while (i < xs.length) {
        const t = xs[i].t;
        let d = 0, c = 0;
        while (i < xs.length && xs[i].t === t) {
            if (xs[i].event)
                d++;
            else
                c++;
            i++;
        }
        if (d > 0) {
            S *= 1 - d / atRisk;
            if (atRisk > d)
                varSum += d / (atRisk * (atRisk - d));
        }
        steps.push({ t, atRisk, events: d, censored: c, S, varSum });
        atRisk -= d + c;
    }
    return steps;
}
/** S(t) from the step function (right-continuous). */
export function survivalAt(steps, t) {
    let S = 1;
    for (const s of steps) {
        if (s.t > t)
            break;
        S = s.S;
    }
    return S;
}
/** Number still waiting (not answered, not censored) just before t. */
export function atRiskAt(steps, t) {
    const s = steps.find((x) => x.t >= t);
    return s ? s.atRisk : 0;
}
/** 95% interval for F(t) = 1 − S(t) (Greenwood, log-log transform), clipped to [0, 1]. */
export function answeredByCI(steps, t) {
    let S = 1, v = 0;
    for (const s of steps) {
        if (s.t > t)
            break;
        S = s.S;
        v = s.varSum;
    }
    if (S >= 1 || S <= 0 || v === 0)
        return { F: 1 - S, lo: 1 - S, hi: 1 - S };
    const se = Math.sqrt(v) / Math.abs(Math.log(S));
    const loS = Math.pow(S, Math.exp(1.96 * se)), hiS = Math.pow(S, Math.exp(-1.96 * se));
    return { F: 1 - S, lo: Math.max(0, 1 - hiS), hi: Math.min(1, 1 - loS) };
}
export const WINDOW_RULE = { minApplications: 20, minAnswers: 8, minAtRisk: 10, minTailDays: 14, maxResidual: 0.1, tailAtRisk: 5, minDay: 7, maxDay: 45 };
/** The response window supported by the data: after it, an application still silent rarely gets answered. */
export function responseWindow(obs, currentDays, rule = WINDOW_RULE) {
    const steps = kaplanMeier(obs);
    const answers = obs.filter((o) => o.event).length;
    const tail = steps.filter((s) => s.atRisk >= rule.tailAtRisk);
    const horizon = tail.length ? tail[tail.length - 1].t : 0;
    const Sh = survivalAt(steps, horizon);
    const residual = (d) => { const Sd = survivalAt(steps, d); return Sd > 0 ? (Sd - Sh) / Sd : 0; };
    const answeredBy = {};
    for (const d of [7, 14, 21, 30, 45])
        if (d <= horizon) {
            const c = answeredByCI(steps, d);
            answeredBy[`${d}d`] = { pct: round(c.F), lo: round(c.lo), hi: round(c.hi), atRisk: atRiskAt(steps, d) };
        }
    const base = { applications: obs.length, answers, censored: obs.length - answers, horizonDays: Math.floor(horizon), answeredBy,
        residualAtCurrent: currentDays + rule.minTailDays <= horizon && atRiskAt(steps, currentDays) >= rule.minAtRisk ? round(residual(currentDays)) : null };
    if (obs.length < rule.minApplications || answers < rule.minAnswers)
        return { ...base, window: null, why: `not enough data (${obs.length} applications, ${answers} answers; need ≥ ${rule.minApplications} and ≥ ${rule.minAnswers})` };
    for (let d = rule.minDay; d <= rule.maxDay; d++) {
        if (d + rule.minTailDays > horizon)
            break; // cannot see late answers past day d yet
        if (atRiskAt(steps, d) < rule.minAtRisk)
            break;
        if (residual(d) <= rule.maxResidual)
            return { ...base, window: d, why: `after day ${d}, only ${pct(residual(d))} of still-silent applications were answered by day ${Math.floor(horizon)} (${atRiskAt(steps, d)} still waiting at day ${d})` };
    }
    return { ...base, window: null, why: `no day in ${rule.minDay}–${rule.maxDay} has ≤ ${pct(rule.maxResidual)} chance of a later answer with ≥ ${rule.minAtRisk} applications still waiting and ≥ ${rule.minTailDays} days of follow-up after it (follow-up reaches day ${Math.floor(horizon)})` };
}
const round = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${Math.round(100 * x)}%`;
//# sourceMappingURL=survival.js.map