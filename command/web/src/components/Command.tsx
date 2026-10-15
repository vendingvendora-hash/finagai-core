import { useEffect, useMemo, useRef, useState } from "react";
import type { Conn } from "../live/store";
import { calmSentences, canCannot, NEEDS_LABEL, type CommandView } from "../model/command";
import type { LiveEvent, Snapshot, SnapshotNeed } from "../model/types";
import { currentResolver } from "../model/current";
import { buildUnits, historyText, openSubjects, transitionOf, verbOf, type Unit } from "../model/units";
import { withWhy, type WhyTarget } from "../inspector/model";
import { fmtAgo, fmtDay, fmtDue, fmtShortDay, fmtTime, fmtWhen } from "../format";

interface Props {
  view: CommandView; snapshot: Snapshot; events: LiveEvent[]; arrivedLive: Record<number, number>; conn: Conn; now: number;
  gaps: Array<{ from: number; to: number; missed: number }>; everything: boolean; setEverything?: (v: boolean) => void;
  lastSeen: number; reliabilityWhy: string[]; reliabilityVerdict: string | null; links: Set<string>;
  /** open the read-only Why inspector (Review → the item; Why? → how it got here) */
  onWhy: (t: WhyTarget, focus: "review" | "chain") => void;
}
type OnWhy = Props["onWhy"];
const RAIL_MS = 12 * 3_600_000;

export function CommandScreen(p: Props) {
  const v = p.view;
  const live = p.conn === "live";
  // units touching Finagai's internal test Area are dropped (spec §2.1); "Everything" (diagnostic) shows them
  // the rail covers 12 hours; older events are kept only as context (linking units to internal test objects)
  // ◆ on an activity item = its subject is open in Needs you right now (the snapshot), never inferred from history
  const open = useMemo(() => openSubjects(v.needs), [v.needs]);
  // unfinished work (running / waiting / blocked / recovering) reads in its current state — from the snapshot only
  const current = useMemo(() => currentResolver(p.snapshot, v), [p.snapshot, v]);
  const units = useMemo(() => buildUnits(p.events, v.internalAreaIds, { everything: p.everything, links: p.links, open, current }).filter((u) => Date.parse(u.at) >= p.now - RAIL_MS),
    [p.events, v.internalAreaIds, p.everything, p.links, open, current, Math.floor(p.now / 60_000)]);
  const since = units.filter((u) => u.atId > p.lastSeen).length;
  // a decision card may move (fade in) only when its escalation.opened event just arrived over the live stream
  const openedLive = useMemo(() => new Set(p.events.filter((e) => e.class === "escalation.opened" && e.entity.id && p.now - (p.arrivedLive[e.eventId] ?? -Infinity) < 10_000).map((e) => e.entity.id!)),
    [p.events, p.arrivedLive, p.now]);
  return (
    <div className={`command ${v.calm ? "command--calm" : ""}`}>
      <AreasRail view={v} />
      <main className="main" aria-label="Command">
        {v.calm ? <Calm view={v} /> : <>
          <NeedsYou needs={v.needs} now={p.now} live={live} areaName={v.areaName} openedLive={openedLive} onWhy={p.onWhy} />
          <OwnershipLine />
          <Handling view={v} now={p.now} live={live} />
        </>}
        <section className="mobile-recent" aria-label="Recent changes">
          <h2 className="section-title">Recent changes</h2>
          <UnitList units={units.slice(0, 5)} now={p.now} arrived={p.arrivedLive} gaps={p.gaps} onWhy={p.onWhy} />
        </section>
        <nav className="mobile-areas" aria-label="Areas">{v.areas.map((a) => <span key={a.area.id} className={`chip chip--${a.area.health.color}`}>{a.needs ? "◆ " : ""}{a.area.name}</span>)}</nav>
      </main>
      <aside className="activity" aria-label="Live activity">
        <div className="activity__head">
          <h2 className="section-title">Live activity</h2>
          {p.setEverything && <label className="activity__mode"><input type="checkbox" checked={p.everything} onChange={(e) => p.setEverything!(e.target.checked)} /> Everything</label>}
        </div>
        <UnitList units={units.slice(0, 40)} now={p.now} arrived={p.arrivedLive} gaps={p.gaps} onWhy={p.onWhy} empty="Nothing in the last 12 hours." />
      </aside>
      <ContextStrip view={v} since={since} units={units} now={p.now} why={p.reliabilityWhy} verdict={p.reliabilityVerdict} onWhy={p.onWhy} />
    </div>
  );
}

function AreasRail({ view }: { view: CommandView }) {
  return (
    <nav className="areas" aria-label="Areas">
      <h2 className="section-title">Areas</h2>
      {view.areas.length === 0 && <p className="muted">Areas Finagai manages appear here.</p>}
      <ul>
        {view.areas.map((a) => (
          <li key={a.area.id} className="areas__row">
            <span className={`owner-mark ${a.needs ? "owner-mark--julian" : ""}`} aria-hidden="true">{a.needs ? "◆" : ""}</span>
            <span className="areas__name">{a.area.name}</span>
            <span className={`dot dot--${a.area.health.color}`} title={[...a.area.health.breaches, ...a.area.health.warnings].join("\n") || "every service level is met"}>●<span className="sr-only">{a.area.health.color}</span></span>
            <span className="areas__fact">{a.fact}</span>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NeedsYou({ needs, now, live, areaName, openedLive, onWhy }: { needs: SnapshotNeed[]; now: number; live: boolean; areaName: (id: string | null) => string | null; openedLive: Set<string>; onWhy: OnWhy }) {
  // a decision that disappears while live is shown as resolved for 6 s (a real escalation.resolved event caused it)
  const prev = useRef<SnapshotNeed[]>(needs);
  const [resolved, setResolved] = useState<Array<{ n: SnapshotNeed; at: number }>>([]);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; prev.current = needs; return; }
    const gone = prev.current.filter((o) => !needs.some((n) => n.id === o.id));
    if (gone.length && live) setResolved((r) => [...r, ...gone.map((n) => ({ n, at: Date.now() }))]);
    prev.current = needs;
  }, [needs, live]);
  useEffect(() => {
    if (!resolved.length) return;
    const t = setTimeout(() => setResolved((r) => r.filter((x) => Date.now() - x.at < 6_000)), 6_100);
    return () => clearTimeout(t);
  }, [resolved]);
  const shown = needs.slice(0, 3), more = needs.slice(3);
  return (
    <section className="needs" aria-label="Needs you">
      <h2 className="section-title section-title--julian">Needs you</h2>
      {shown.map((n) => {
        const cc = canCannot(n); const overdue = n.due_at && Date.parse(n.due_at) < now;
        return (
          <article key={n.id} className={`card ${openedLive.has(n.id) ? "card--new" : ""}`}>
            <header className="card__head">
              <span className="card__kind"><span className="owner-mark owner-mark--julian" aria-hidden="true">◆</span> {NEEDS_LABEL[n.needs]}{areaName(n.area_id) ? ` · ${areaName(n.area_id)}` : ""}</span>
              <span className={`card__due ${overdue ? "is-overdue" : ""}`}>{n.due_at ? fmtDue(n.due_at, now) : `since ${fmtAgo(n.created_at, now, live)}`}</span>
            </header>
            <p className="card__body">{n.summary}</p>
            {cc && <dl className="card__cc"><dt>Finagai can</dt><dd>{cc.can}</dd><dt>Only you can</dt><dd>{cc.only}</dd></dl>}
            <div className="card__actions">
              <WhyLink t={{ kind: "object", type: "escalation", id: n.id }} focus="review" onWhy={onWhy} className="btn">Review</WhyLink>
              <WhyLink t={{ kind: "object", type: "escalation", id: n.id }} focus="chain" onWhy={onWhy} className="btn btn--quiet">Why?</WhyLink>
            </div>
          </article>
        );
      })}
      {more.length > 0 && <details className="more"><summary>{more.length} more decision{more.length === 1 ? "" : "s"}</summary>
        <ul>{more.map((n) => <li key={n.id}><span className="owner-mark owner-mark--julian" aria-hidden="true">◆</span> {n.summary} <span className="muted">{n.due_at ? fmtDue(n.due_at, now) : ""}</span>{" "}
          <WhyLink t={{ kind: "object", type: "escalation", id: n.id }} focus="review" onWhy={onWhy} className="linkish">Review</WhyLink></li>)}</ul></details>}
      {resolved.map(({ n }) => <p key={`r${n.id}`} className="resolved">No longer needs you — {n.summary.split(" — ")[0]}</p>)}
      {shown.length === 0 && resolved.length === 0 && <p className="muted">Nothing needs you.</p>}
    </section>
  );
}

function OwnershipLine() {
  return <div className="ownership-line" role="separator" aria-label="Above: yours. Below: what Finagai is handling." />;
}

function Handling({ view: v, now, live }: { view: CommandView; now: number; live: boolean }) {
  const rows: Array<{ n: number | null; label: string; fact: string; warn?: boolean }> = [
    { n: v.waits.length, label: `wait${v.waits.length === 1 ? "" : "s"} on other people`, fact: v.nextDue ? `next due ${fmtShortDay(v.nextDue.at)}` : "" },
    { n: v.tasksRunning.length, label: `Mac task${v.tasksRunning.length === 1 ? "" : "s"} running`, fact: v.tasksRunning[0]?.request.slice(0, 60) ?? "" },
    { n: v.problems.length, label: `problem${v.problems.length === 1 ? "" : "s"} Finagai is fixing`, fact: v.problems[0] ? `${v.problems[0].summary.slice(0, 60)} · ${fmtAgo(v.problems[0].first_seen_at, now, live)}` : "" },
    { n: v.rulesArmed, label: `"tell me when" rule${v.rulesArmed === 1 ? "" : "s"} armed`, fact: "" },
    { n: null, label: v.stalled ? "Finagai's checks stopped" : "Checks every 5 min", fact: v.lastTick ? `last ${fmtTime(v.lastTick)}` : "never", warn: v.stalled },
  ];
  return (
    <section className="handling" aria-label="Finagai is handling">
      <h2 className="section-title section-title--finagai">Finagai is handling</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.label} className={`handling__row ${r.n === 0 ? "is-zero" : ""} ${r.warn ? "is-warn" : ""}`}>
            <span className="owner-mark owner-mark--finagai" aria-hidden="true">○</span>
            <span className="handling__label">{r.n !== null ? <b>{r.n}</b> : null} {r.label}</span>
            <span className="handling__fact">{r.fact}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Calm({ view }: { view: CommandView }) {
  return (
    <section className="calm" aria-label="Nothing needs you">
      <p className="calm__statement">Nothing needs you.</p>
      <OwnershipLine />
      {calmSentences(view, fmtDay, fmtTime).map((s) => <p key={s} className="calm__line">{s}</p>)}
    </section>
  );
}

/** A real link (deep-linkable, opens in a new tab) that opens the inspector in place on a plain click. */
function WhyLink({ t, focus, onWhy, className, children, label }: { t: WhyTarget; focus: "review" | "chain"; onWhy: OnWhy; className?: string; children: React.ReactNode; label?: string }) {
  return <a href={withWhy(location.search, t)} className={className} aria-label={label}
    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onWhy(t, focus); }}>{children}</a>;
}

function UnitList({ units, now, arrived, gaps, empty, onWhy }: { units: Unit[]; now: number; arrived: Record<number, number>; gaps: Array<{ from: number; to: number; missed: number }>; empty?: string; onWhy: OnWhy }) {
  if (!units.length) return <p className="muted">{empty ?? "Nothing yet."}</p>;
  const items: Array<{ kind: "unit"; u: Unit } | { kind: "gap"; g: { from: number; to: number; missed: number } }> = [];
  const gs = [...gaps].sort((a, b) => b.to - a.to); let gi = 0;
  for (const u of units) {
    while (gi < gs.length && Date.parse(u.at) < gs[gi]!.from) { items.push({ kind: "gap", g: gs[gi]! }); gi++; }
    items.push({ kind: "unit", u });
  }
  return (
    <ol className="units">
      {items.map((it) => it.kind === "gap"
        ? <li key={`g${it.g.from}`} className="gap">Disconnected {fmtTime(it.g.from)}–{fmtTime(it.g.to)} · {it.g.missed} change{it.g.missed === 1 ? "" : "s"} caught up</li>
        : <UnitItem key={it.u.key} u={it.u} now={now} arrived={arrived} onWhy={onWhy} />)}
    </ol>
  );
}

function UnitItem({ u, now, arrived, onWhy }: { u: Unit; now: number; arrived: Record<number, number>; onWhy: OnWhy }) {
  const [open, setOpen] = useState(false);
  const arrivals = u.events.map((e) => arrived[e.eventId]).filter((x): x is number => typeof x === "number");
  const latest = arrivals.length ? Math.max(...arrivals) : 0;
  const isNew = arrivals.length > 0 && arrivals.length === u.events.length;          // the whole item arrived live
  const grew = !isNew && latest > 0 && now - latest < 6_000 ? arrivals.length : 0;
  return (
    <li className={`unit ${isNew && now - latest < 1_000 ? "unit--new" : ""} ${u.outcome ? `unit--${u.outcome}` : ""} ${u.current ? "unit--open" : ""}`} data-unit={u.key} data-state={u.current ? "open" : "done"}>
      <div className="unit__row">
        <button className="unit__head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <time className="unit__time" dateTime={u.at}>{fmtWhen(u.at, now)}</time>
          <span className="unit__title">{u.yours && <span className="owner-mark owner-mark--julian" aria-label="needs you now">◆ </span>}{u.title}</span>
          <span className="unit__meta">{u.current ? <span className={`unit__now unit__now--${u.current.owner}`}>Open now · </span> : null}{u.area?.name ? `${u.area.name} · ` : ""}{u.steps.length} step{u.steps.length === 1 ? "" : "s"}{grew ? <span className="chip-new"> +{grew}</span> : null}</span>
        </button>
        <WhyLink t={{ kind: "event", id: u.rootEventId }} focus="chain" onWhy={onWhy} className="unit__why" label={`Why: ${u.title}`}>Why?</WhyLink>
      </div>
      {open && <ol className="steps">{u.steps.map((e) => (
        <li key={e.eventId} className="step">
          <time dateTime={e.at}>{fmtTime(e.at)}</time>
          <span className="step__verb">{verbOf(e.class)}</span>
          <span className="step__text">{historyText(e)}{transitionOf(e) ? <span className="step__tr"> ({transitionOf(e)})</span> : null}{" "}
            <WhyLink t={{ kind: "event", id: e.eventId }} focus="chain" onWhy={onWhy} className="step__why" label={`Why: ${verbOf(e.class)}`}>Why?</WhyLink></span>
        </li>))}</ol>}
    </li>
  );
}

function ContextStrip({ view: v, since, units, now, why, verdict, onWhy }: { view: CommandView; since: number; units: Unit[]; now: number; why: string[]; verdict: string | null; onWhy: OnWhy }) {
  const [tab, setTab] = useState<null | "since" | "upcoming" | "waiting" | "reliability">(null);
  const toggle = (t: typeof tab) => setTab(tab === t ? null : t);
  const people = v.waitingOn.length;
  return (
    <footer className="strip" aria-label="Context">
      {tab && <div className="strip__drawer" role="region" aria-label={tab}>
        {tab === "since" && (since ? <UnitList units={units.slice(0, since)} now={now} arrived={{}} gaps={[]} onWhy={onWhy} /> : <p className="muted">No changes since you last looked.</p>)}
        {tab === "upcoming" && (v.upcoming.length ? <ul className="list">{v.upcoming.map((x) => <li key={x.at + x.text}><span className="list__date">{fmtShortDay(x.at)}</span>{x.yours ? <span className="owner-mark owner-mark--julian">◆ </span> : null}{x.text}</li>)}</ul> : <p className="muted">Nothing due in the next 7 days.</p>)}
        {tab === "waiting" && (people ? <ul className="list">{v.waitingOn.map((w) => <li key={w.who}><b>{w.who}</b> — {w.items.map((i) => `${i.summary}${i.due_at ? ` (due ${fmtShortDay(i.due_at)})` : ""}`).join("; ")}</li>)}</ul> : <p className="muted">Finagai isn't waiting on anyone.</p>)}
        {tab === "reliability" && <div><p><b>{verdict === "healthy" ? "Healthy" : verdict === "degraded" ? "Degraded — Finagai is handling it" : "Checking…"}</b> (last 24 h)</p>{why.length ? <ul className="list">{why.map((w) => <li key={w}>{w}</li>)}</ul> : null}</div>}
      </div>}
      <div className="strip__tabs" role="tablist">
        <button role="tab" aria-selected={tab === "since"} onClick={() => toggle("since")}>{since ? `${since} change${since === 1 ? "" : "s"} since you last looked` : "No changes since you last looked"}</button>
        <button role="tab" aria-selected={tab === "upcoming"} onClick={() => toggle("upcoming")}>{v.upcoming.length ? `Upcoming: ${v.upcoming.length} due this week` : "Nothing due this week"}</button>
        <button role="tab" aria-selected={tab === "waiting"} onClick={() => toggle("waiting")}>{people ? `Waiting on ${people} ${people === 1 ? "party" : "parties"}` : "Waiting on no one"}</button>
        <button role="tab" aria-selected={tab === "reliability"} onClick={() => toggle("reliability")}><span className={`dot dot--${verdict === "healthy" ? "green" : verdict === "degraded" ? "yellow" : "grey"}`}>●</span> Reliability</button>
      </div>
    </footer>
  );
}
