/**
 * Phase 6 (ADR-085, revised): time-to-answer with CENSORING. An application that has not been answered yet is not a
 * missing data point — it is known to have waited at least as long as it has been open. Dropping it (the first
 * version did) keeps only the outcomes that happened, which biases response times DOWN. Kaplan–Meier uses every
 * application: answered ones are events at their answer time, unanswered ones are censored at their follow-up time.
 * Pure functions; no database.
 */

export interface Obs { t: number; event: boolean }               // t in days since the application
export interface KmStep { t: number; atRisk: number; events: number; censored: number; S: number; varSum: number }

/** Kaplan–Meier product-limit estimate of S(t) = P(no answer by t). Censorings tied with events stay at risk. */
export function kaplanMeier(obs: Obs[]): KmStep[] {
  const xs = obs.filter((o) => Number.isFinite(o.t) && o.t >= 0).sort((a, b) => a.t - b.t || Number(b.event) - Number(a.event));
  const steps: KmStep[] = [];
  let atRisk = xs.length, S = 1, varSum = 0, i = 0;
  while (i < xs.length) {
    const t = xs[i]!.t; let d = 0, c = 0;
    while (i < xs.length && xs[i]!.t === t) { if (xs[i]!.event) d++; else c++; i++; }
    if (d > 0) { S *= 1 - d / atRisk; if (atRisk > d) varSum += d / (atRisk * (atRisk - d)); }
    steps.push({ t, atRisk, events: d, censored: c, S, varSum });
    atRisk -= d + c;
  }
  return steps;
}

/** S(t) from the step function (right-continuous). */
export function survivalAt(steps: KmStep[], t: number): number {
  let S = 1;
  for (const s of steps) { if (s.t > t) break; S = s.S; }
  return S;
}
/** Number still waiting (not answered, not censored) just before t. */
export function atRiskAt(steps: KmStep[], t: number): number {
  const s = steps.find((x) => x.t >= t);
  return s ? s.atRisk : 0;
}
/** 95% interval for F(t) = 1 − S(t) (Greenwood, log-log transform), clipped to [0, 1]. */
export function answeredByCI(steps: KmStep[], t: number): { F: number; lo: number; hi: number } {
  let S = 1, v = 0, n = steps[0]?.atRisk ?? 0;
  for (const s of steps) { if (s.t > t) break; S = s.S; v = s.varSum; }
  for (const s of steps) { if (s.t > t) break; if (s.events === 0) continue; n = s.atRisk; }   // at risk at the last answer by t
  // No answer yet by t: the estimate is 0 but not certain — exact binomial 95% upper bound with the n still waiting.
  if (S >= 1) { const m = atRiskAt(steps, t) || n; return { F: 0, lo: 0, hi: m > 0 ? 1 - Math.pow(0.05, 1 / m) : 1 }; }
  if (S <= 0 || v === 0) return { F: 1 - S, lo: 1 - S, hi: 1 - S };
  const se = Math.sqrt(v) / Math.abs(Math.log(S));
  const loS = Math.pow(S, Math.exp(1.96 * se)), hiS = Math.pow(S, Math.exp(-1.96 * se));
  return { F: 1 - S, lo: Math.max(0, 1 - hiS), hi: Math.min(1, 1 - loS) };
}

export interface WindowRule { minApplications: number; minAnswers: number; minAtRisk: number; minTailDays: number; maxResidual: number; maxResidualUpper: number; tailAtRisk: number; minDay: number; maxDay: number }
/** maxResidualUpper: the 95% upper bound of the later-answer chance must also be small — a point estimate from a
 *  handful of late answers is not enough to tell Julian that silence means "no answer". */
export const WINDOW_RULE: WindowRule = { minApplications: 20, minAnswers: 8, minAtRisk: 10, minTailDays: 14, maxResidual: 0.1, maxResidualUpper: 0.2, tailAtRisk: 5, minDay: 7, maxDay: 45 };

/** Later answers after day d (up to the horizon h) as a life-table proportion: k answers in (d, h] among the n still
 *  waiting at d, with those censored strictly inside (d, h) counted as half-exposed (actuarial adjustment). Returns the
 *  proportion and its 95% Wilson upper bound. */
export function lateAnswers(obs: Obs[], d: number, h: number): { k: number; nEff: number; p: number; upper: number } {
  const waiting = obs.filter((o) => o.t > d);
  const k = waiting.filter((o) => o.event && o.t <= h).length;
  const cIn = waiting.filter((o) => !o.event && o.t < h).length;
  const nEff = Math.max(0, waiting.length - cIn / 2);
  if (nEff <= 0) return { k, nEff, p: 0, upper: 1 };
  const z = 1.96, p = Math.min(1, k / nEff), dd = 1 + (z * z) / nEff;
  const upper = Math.min(1, (p + (z * z) / (2 * nEff) + z * Math.sqrt((p * (1 - p)) / nEff + (z * z) / (4 * nEff * nEff))) / dd);
  return { k, nEff, p, upper };
}

export interface WindowEstimate {
  applications: number; answers: number; censored: number;
  /** last day with enough applications still waiting to say anything (≥ tailAtRisk) */
  horizonDays: number;
  answeredBy: Record<string, { pct: number; lo: number; hi: number; atRisk: number }>;
  /** P(an application still silent on day d is answered later, up to the horizon) at the current window */
  residualAtCurrent: number | null;
  /** smallest day whose residual chance of a later answer is ≤ maxResidual, with enough data on both sides; null = not identifiable */
  window: number | null;
  lateAnswers?: { k: number; nEff: number; p: number; upper: number };
  /** every candidate day with its numbers and the rules it fails */
  candidateDays?: CandidateDay[];
  why: string;
}

/** The response window supported by the data: after it, an application still silent rarely gets answered. */
export function responseWindow(obs: Obs[], currentDays: number, rule: WindowRule = WINDOW_RULE): WindowEstimate {
  const steps = kaplanMeier(obs);
  const answers = obs.filter((o) => o.event).length;
  const tail = steps.filter((s) => s.atRisk >= rule.tailAtRisk);
  const horizon = tail.length ? tail[tail.length - 1]!.t : 0;
  const Sh = survivalAt(steps, horizon);
  const residual = (d: number) => { const Sd = survivalAt(steps, d); return Sd > 0 ? (Sd - Sh) / Sd : 0; };
  const answeredBy: WindowEstimate["answeredBy"] = {};
  for (const d of [7, 14, 21, 30, 45]) if (d <= horizon) { const c = answeredByCI(steps, d); answeredBy[`${d}d`] = { pct: round(c.F), lo: round(c.lo), hi: round(c.hi), atRisk: atRiskAt(steps, d) }; }
  const base = { applications: obs.length, answers, censored: obs.length - answers, horizonDays: Math.floor(horizon), answeredBy,
    residualAtCurrent: currentDays + rule.minTailDays <= horizon && atRiskAt(steps, currentDays) >= rule.minAtRisk ? round(residual(currentDays)) : null };
  if (obs.length < rule.minApplications || answers < rule.minAnswers)
    return { ...base, window: null, why: `not enough data (${obs.length} applications, ${answers} answers; need ≥ ${rule.minApplications} and ≥ ${rule.minAnswers})` };
  const candidateDays = candidateTable(obs, steps, horizon, residual, rule);
  const first = candidateDays.find((c) => c.passes);
  if (first) {
    const late = lateAnswers(obs, first.day, horizon);
    return { ...base, candidateDays, window: first.day, lateAnswers: late,
      why: `of the applications still silent after day ${first.day} (${Math.round(late.nEff)} effective), ${late.k} were answered later, by day ${Math.floor(horizon)} (${pct(first.kmLaterRate)}; 95% upper bound ${pct(late.upper)})` };
  }
  return { ...base, candidateDays, window: null, why: `no day in ${rule.minDay}–${rule.maxDay} where later answers are ≤ ${pct(rule.maxResidual)} AND their 95% upper bound ≤ ${pct(rule.maxResidualUpper)}, with ≥ ${rule.minAtRisk} still waiting and ≥ ${rule.minTailDays} days of follow-up after it (follow-up reaches day ${Math.floor(horizon)})` };
}

export interface CandidateDay {
  day: number; atRisk: number; stillSilentAfter: number; censoredBeforeHorizon: number; effective: number; laterAnswers: number;
  kmLaterRate: number; lifeTableRate: number; upper95: number; followUpAfterDays: number; passes: boolean; fails: string[];
}
/** Every candidate day with the numbers each rule is checked against, and which rules it fails (empty = passes). */
function candidateTable(obs: Obs[], steps: KmStep[], horizon: number, residual: (d: number) => number, rule: WindowRule): CandidateDay[] {
  const out: CandidateDay[] = [];
  for (let d = rule.minDay; d <= rule.maxDay; d++) {
    const late = lateAnswers(obs, d, horizon);
    const waiting = obs.filter((o) => o.t > d);
    const row = { day: d, atRisk: atRiskAt(steps, d), stillSilentAfter: waiting.length, censoredBeforeHorizon: waiting.filter((o) => !o.event && o.t < horizon).length,
      effective: round(late.nEff), laterAnswers: late.k, kmLaterRate: round(residual(d)), lifeTableRate: round(late.p), upper95: round(late.upper), followUpAfterDays: Math.max(0, Math.floor(horizon - d)) };
    const fails: string[] = [];
    if (row.followUpAfterDays < rule.minTailDays) fails.push(`only ${row.followUpAfterDays} days of follow-up after it (need ${rule.minTailDays})`);
    if (row.atRisk < rule.minAtRisk) fails.push(`only ${row.atRisk} still waiting (need ${rule.minAtRisk})`);
    if (row.kmLaterRate > rule.maxResidual) fails.push(`later-answer rate ${pct(row.kmLaterRate)} > ${pct(rule.maxResidual)}`);
    if (row.upper95 > rule.maxResidualUpper) fails.push(`95% upper bound ${pct(row.upper95)} > ${pct(rule.maxResidualUpper)}`);
    out.push({ ...row, passes: fails.length === 0, fails });
  }
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(100 * x)}%`;
