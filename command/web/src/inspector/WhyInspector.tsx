/**
 * The Why inspector (spec §6, Slice 3): read-only. A 480 px right panel on desktop, a full-screen sheet on mobile.
 * Shows the recorded causal chain behind one event exactly as Core returns it (/live/chain), missing causes as missing,
 * evidence from the chain, who owns it now (authoritative snapshot only), what Finagai can / only Julian can do while it
 * is open, before → after, and the record's authorization / verification / confidence / provenance. Event ids,
 * sequence numbers and correlation ids live only under "Technical details". No actions: nothing here changes anything.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { fmtDateTime, fmtShortDay, fmtTime } from "../format";
import type { CommandView } from "../model/command";
import type { LiveEvent, Snapshot } from "../model/types";
import { chainModel, headingOf, ownerNow, recordFacts, whyValue, type ChainLine, type OwnerNow, type WhyTarget } from "./model";
import { loadWhy, WhyLoadError, type WhyData, type WhyFailure } from "./load";

export interface Crumb { value: string; heading: string }
interface Props {
  target: WhyTarget | "invalid";
  focus: "review" | "chain";
  trail: Crumb[];
  view: CommandView; snapshot: Snapshot; events: LiveEvent[];
  isInternal: (e: LiveEvent) => boolean;
  /** the live connection is up (a load that failed while offline is retried when it comes back) */
  live: boolean;
  onClose: () => void;
  onReroot: (t: WhyTarget, fromHeading: string) => void;
  onBack: (index: number) => void;
  fetchFn?: typeof fetch;
}

/** Tagged with the target it was loaded for: a result for an earlier target is never shown under a new one. */
type Load = { key: string } & ({ state: "loading" } | { state: "ok"; data: WhyData } | { state: "error"; reason: WhyFailure | "invalid" });

export function WhyInspector(p: Props) {
  const key = p.target === "invalid" ? "invalid" : whyValue(p.target);
  const [loaded, setLoad] = useState<Load>({ key, state: "loading" });
  const load: Load = loaded.key === key ? loaded : { key, state: "loading" };
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (p.live && load.state === "error" && load.reason === "offline") setAttempt((a) => a + 1); }, [p.live]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const howRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (p.target === "invalid") { setLoad({ key, state: "error", reason: "invalid" }); return; }
    const ac = new AbortController();
    setLoad({ key, state: "loading" });
    loadWhy(p.target, p.fetchFn, ac.signal)
      .then((data) => { if (!ac.signal.aborted) setLoad({ key, state: "ok", data }); })
      .catch((e) => { if (!ac.signal.aborted) setLoad({ key, state: "error", reason: e instanceof WhyLoadError ? e.reason : "offline" }); });
    return () => ac.abort();
  }, [key, attempt]);

  // Esc closes (spec §12.8)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); p.onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [p.onClose]);

  // focus: Review → the heading; Why? → "How it got here"
  useEffect(() => {
    if (load.state === "loading") { panelRef.current?.focus(); return; }
    const el = p.focus === "chain" && load.state === "ok" ? howRef.current : titleRef.current;
    el?.focus(); if (p.focus === "chain") el?.scrollIntoView?.({ block: "start" });
  }, [load.state, key, p.focus]);

  const model = load.state === "ok" ? chainModel(load.data.chain, load.data.rootId, p.isInternal) : null;
  const rootInternal = !!model && model.lines.find((l) => l.isRoot)!.internal;
  const heading = model && !rootInternal ? headingOf(model.root) : "";
  const owner = model && !rootInternal ? ownerNow(model.root, p.view, p.snapshot, p.events) : null;
  const areaName = model?.root.area?.name ?? null;

  return (
    <aside ref={panelRef} className="why" role="dialog" aria-modal="false" aria-labelledby="why-title" tabIndex={-1} data-why={key}>
      <header className="why__bar">
        <p className="why__eyebrow">Why is this here?</p>
        <button className="why__close" onClick={p.onClose} aria-label="Close the explanation">✕</button>
      </header>
      {p.trail.length > 0 && (
        <nav className="why__trail" aria-label="Where you came from">
          {p.trail.map((c, i) => <span key={`${c.value}-${i}`}><button className="linkish" onClick={() => p.onBack(i)}>{short(c.heading)}</button><span aria-hidden="true"> › </span></span>)}
          <span className="why__here">this step</span>
        </nav>
      )}
      <div className="why__body">
        {load.state === "loading" && <p className="muted" role="status">Loading what Finagai recorded…</p>}
        {load.state === "error" && <Failure reason={load.reason} titleRef={titleRef} />}
        {model && rootInternal && <><h2 id="why-title" ref={titleRef} tabIndex={-1} className="why__title">Finagai's internal testing</h2>
          <p className="muted">This belongs to Finagai's own test Area; its content isn't shown in the Command Center.</p>
          <section className="why__section" aria-labelledby="why-how">
            <h3 id="why-how" ref={howRef} tabIndex={-1} className="why__h">How it got here</h3>
            <ol className="chain" data-chain-ids={model.ids.join(",")}>
              {model.lines.map((l, i) => <ChainItem key={l.e.eventId} l={l} prev={model.lines[i - 1]?.e ?? null}
                onReroot={() => p.onReroot({ kind: "event", id: l.e.eventId }, "Finagai's internal testing")} />)}
            </ol>
          </section></>}
        {model && !rootInternal && owner && <>
          <h2 id="why-title" ref={titleRef} tabIndex={-1} className="why__title">{heading}</h2>
          <p className="why__status">{owner.kind === "julian"
            ? <><span className="owner-mark owner-mark--julian" aria-hidden="true">◆</span> Yours now · {owner.label}{areaName ? ` · ${areaName}` : ""}</>
            : owner.kind === "none" ? <>Recorded {fmtDateTime(model.root.at)}{areaName ? ` · ${areaName}` : ""}</>
            : <><span className="owner-mark owner-mark--finagai" aria-hidden="true">○</span> Open now · {nowPhrase(owner)}{areaName ? ` · ${areaName}` : ""}</>}</p>

          <section className="why__section" aria-labelledby="why-how">
            <h3 id="why-how" ref={howRef} tabIndex={-1} className="why__h">How it got here</h3>
            <ol className="chain" data-chain-ids={model.ids.join(",")}>
              {model.lines.map((l, i) => <ChainItem key={l.e.eventId} l={l} prev={model.lines[i - 1]?.e ?? null}
                onReroot={() => p.onReroot({ kind: "event", id: l.e.eventId }, heading)} />)}
            </ol>
            <p className="why__note">Each line is an event Finagai recorded; nothing is added between them. What happened after this step isn't shown yet.</p>
          </section>

          {model.lines.find((l) => l.isRoot)!.transition && <section className="why__section" aria-labelledby="why-change">
            <h3 id="why-change" className="why__h">Before → after</h3>
            <p className="why__change">{model.lines.find((l) => l.isRoot)!.transition}</p>
          </section>}

          <section className="why__section" aria-labelledby="why-evidence">
            <h3 id="why-evidence" className="why__h">Evidence</h3>
            {model.evidence.length
              ? <ul className="why__evidence">{model.evidence.map((l) => <li key={l.e.eventId} data-event-id={l.e.eventId}><time dateTime={l.e.at}>{fmtShortDay(l.e.at)} {fmtTime(l.e.at)}</time> {l.text || l.verb}</li>)}</ul>
              : <p className="muted">No evidence is recorded in this chain.</p>}
          </section>

          <section className="why__section" aria-labelledby="why-owner">
            <h3 id="why-owner" className="why__h">Owner</h3>
            <Owner o={owner} root={model.root} />
          </section>

          <section className="why__section" aria-labelledby="why-record">
            <h3 id="why-record" className="why__h">Record</h3>
            <dl className="why__dl">
              <dt>When</dt><dd>{fmtDateTime(model.root.at)}</dd>
              {recordFacts(model.root).map((f) => <Fact key={f.label} {...f} />)}
            </dl>
          </section>

          <details className="why__tech">
            <summary>Technical details</summary>
            <dl className="why__dl why__dl--mono">
              <dt>Event</dt><dd>{model.root.eventId}{model.root.seq ? ` · seq ${model.root.seq}` : ""}</dd>
              <dt>Class</dt><dd>{model.root.class} · {model.root.action}</dd>
              {model.root.entity.type && <><dt>Entity</dt><dd>{model.root.entity.type}{model.root.entity.id ? ` ${model.root.entity.id}` : ""}</dd></>}
              {model.root.cause.correlationId && <><dt>Correlation</dt><dd>{model.root.cause.correlationId}</dd></>}
              {model.root.cause.requestId && <><dt>Request</dt><dd>{model.root.cause.requestId}</dd></>}
              <dt>Caused by</dt><dd>{model.root.cause.eventIds.length ? model.root.cause.eventIds.join(", ") : "nothing recorded (a starting point)"}</dd>
              <dt>Chain</dt><dd>{model.ids.join(" → ")}</dd>
              {model.missing.length > 0 && <><dt>Not available</dt><dd>{model.missing.join(", ")}</dd></>}
            </dl>
          </details>
        </>}
      </div>
    </aside>
  );
}

function ChainItem({ l, prev, onReroot }: { l: ChainLine; prev: LiveEvent | null; onReroot: () => void }) {
  const sameDay = prev && new Date(prev.at).toDateString() === new Date(l.e.at).toDateString();
  const when = sameDay ? fmtTime(l.e.at) : `${fmtShortDay(l.e.at)} ${fmtTime(l.e.at)}`;
  const body = <>
    <time dateTime={l.e.at} className="chain__time">{when}</time>
    <span className="chain__text"><span className="chain__verb">{l.verb}</span>{l.text ? <> — {l.text}</> : null}{l.transition ? <span className="chain__tr"> ({l.transition})</span> : null}</span>
  </>;
  return (
    <li className={`chain__item ${l.isRoot ? "chain__item--root" : ""}`} data-event-id={l.e.eventId}>
      {l.missingCauses.length > 0 && <p className="chain__missing" data-missing-causes={l.missingCauses.join(",")}>
        An earlier cause was recorded but isn't available{l.missingCauses.length > 1 ? ` (${l.missingCauses.length})` : ""} — it is older than Finagai keeps, or further back than the explanation follows.</p>}
      {l.startedHere && <p className="chain__start">Started here</p>}
      {l.isRoot || l.internal
        ? <div className="chain__row">{body}{l.isRoot ? <span className="chain__this">this</span> : null}</div>
        : <button className="chain__row chain__row--link" onClick={onReroot} aria-label={`Explain this step: ${l.verb}${l.text ? ` — ${l.text}` : ""}`}>{body}</button>}
    </li>
  );
}

function Owner({ o, root }: { o: OwnerNow; root: LiveEvent }) {
  const then = root.nextOwner === "julian" ? "the next step was yours" : root.nextOwner === "finagai" ? "the next step was Finagai's" : null;
  switch (o.kind) {
    case "julian": return <>
      <p><span className="owner-mark owner-mark--julian" aria-hidden="true">◆</span> <b>You</b> — open in Needs you since {fmtDateTime(o.need.created_at)}{o.need.due_at ? ` · due ${fmtShortDay(o.need.due_at)}` : ""}.</p>
      {o.cc && <dl className="card__cc"><dt>Finagai can</dt><dd>{o.cc.can}</dd><dt>Only you can</dt><dd>{o.cc.only}</dd></dl>}
    </>;
    case "wait": return o.wait.owner === "julian"
      ? <p><span className="owner-mark owner-mark--julian" aria-hidden="true">◆</span> <b>You</b> — {o.wait.summary}</p>
      : <p><span className="owner-mark owner-mark--finagai" aria-hidden="true">○</span> <b>Finagai</b> is watching it — waiting on {o.wait.counterparty ?? "someone"}{o.wait.due_at ? `, due ${fmtShortDay(o.wait.due_at)}` : ""}.</p>;
    case "task": return <p><span className="owner-mark owner-mark--finagai" aria-hidden="true">○</span> <b>Finagai</b> — {nowPhrase(o)}.</p>;
    case "exception": return o.exception.owner === "julian"
      ? <p><span className="owner-mark owner-mark--julian" aria-hidden="true">◆</span> <b>You</b> — {o.exception.summary}</p>
      : <p><span className="owner-mark owner-mark--finagai" aria-hidden="true">○</span> <b>Finagai</b> is handling it — {o.exception.summary}</p>;
    default: return <>
      <p>Nothing about this is open now.</p>
      {then && <p className="muted">When this was recorded, {then}.</p>}
    </>;
  }
}

/** The current state of unfinished work, present tense, from the snapshot (OwnerNow), for the status line. */
function nowPhrase(o: OwnerNow): string {
  switch (o.kind) {
    case "task": return `Mac task ${o.task.code} is ${o.task.status === "active" ? "running" : o.task.status.replace(/_/g, " ")}`;
    case "wait": return o.wait.owner === "julian" ? "waiting on you" : `still waiting on ${o.wait.counterparty ?? "a reply"}`;
    case "exception": return o.exception.owner === "julian" ? "needs you" : "Finagai is fixing it";
    default: return "";
  }
}

function Fact({ label, value }: { label: string; value: string }) { return <><dt>{label}</dt><dd>{value}</dd></>; }

function Failure({ reason, titleRef }: { reason: WhyFailure | "invalid"; titleRef: RefObject<HTMLHeadingElement> }) {
  const text = reason === "invalid" ? "That link doesn't point to anything Finagai recorded."
    : reason === "not_found" ? "Finagai has no record of this (it may be older than the history it keeps)."
    : reason === "signed_out" ? "You're signed out. Sign in again to see the explanation."
    : "Can't load the explanation while Finagai is unreachable. It will load when the connection is back.";
  return <><h2 id="why-title" ref={titleRef} className="why__title" tabIndex={-1}>Can't show this</h2><p className="muted" role="status">{text}</p></>;
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s);
