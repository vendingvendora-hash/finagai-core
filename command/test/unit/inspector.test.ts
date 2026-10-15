/** The Why inspector's model and loader (Slice 3): Core's chain exactly, missing causes as missing, ownership from the snapshot only. */
import { describe, expect, it } from "vitest";
import { deriveCommand } from "../../web/src/model/command";
import { chainModel, headingOf, ownerNow, parseWhy, recordFacts, withWhy } from "../../web/src/inspector/model";
import { loadWhy, WhyLoadError } from "../../web/src/inspector/load";
import { area, corr, ev, need, snapshot, wait } from "./fixtures";

const career = area("a-career", "Career");
const F = "55555555-5555-4555-8555-555555555555", E = "e3000000-0000-4000-8000-000000000003";
const SUM = "No answer from Beth Young by 2026-10-14 — approve a follow-up (Finagai drafts it; it goes out as you), give a new date, or close it";
/** Production chain 2408 → 2416 (Beth Young), trimmed. */
const chain = [
  ev({ eventId: 2408, class: "evidence.observed", actor: "system", cause: corr("t"), summary: "evidence.observed: Overdue: Waiting on Beth Young — Outcome of the 9/28 Altarum panel interview (due 2026-10-14)" }),
  ev({ eventId: 2409, class: "evidence.classified", actor: "system", cause: { correlationId: "t", eventIds: [2408], requestId: null }, summary: "evidence.classified: Overdue: Waiting on Beth Young" }),
  ev({ eventId: 2410, class: "workflow.started", cause: { correlationId: "t", eventIds: [2409], requestId: null }, summary: "workflow.started: followup.due" }),
  ev({ eventId: 2411, class: "wait.expired", actor: "system", area: { id: career.id, name: "Career" }, entity: { type: "followup", id: F }, cause: { correlationId: "t", eventIds: [2410], requestId: null },
    summary: "wait.expired: Waiting on Beth Young — Outcome of the 9/28 Altarum panel interview", before: { state: "waiting" }, after: { state: "overdue" } }),
  ev({ eventId: 2413, class: "escalation.opened", area: { id: career.id, name: "Career" }, entity: { type: "escalation", id: E }, nextOwner: "julian", cause: { correlationId: "t", eventIds: [2411], requestId: null },
    summary: `escalation.opened: ${SUM}`, after: { key: `overdue:${F}:2026-10-14`, needs: "principal_reserved", summary: SUM } }),
];

describe("deep links", () => {
  it("?why=<eventId> and ?why=<type>:<id>; anything else is invalid; other parameters are kept", () => {
    expect(parseWhy("?why=2413")).toEqual({ kind: "event", id: 2413 });
    expect(parseWhy(`?diag&why=escalation:${E}`)).toEqual({ kind: "object", type: "escalation", id: E });
    for (const bad of ["?why=", "?why=../x", "?why=a:b:c", "?why=<script>", "?why=escalation:", "?why=1e3"]) expect(parseWhy(bad)).toBe("invalid");
    expect(parseWhy("?diag")).toBeNull();
    expect(withWhy("?diag", { kind: "event", id: 7 })).toBe("?diag&why=7");
    expect(withWhy("?diag&why=7", { kind: "object", type: "escalation", id: E })).toBe(`?diag&why=escalation:${E}`);
    expect(withWhy("?diag&why=7", null)).toBe("?diag");
    expect(withWhy("?why=7", null)).toBe("");
  });
});

describe("chainModel", () => {
  it("is exactly Core's chain, ordered by id, root marked; an uncaused event is where it started", () => {
    const m = chainModel([...chain].reverse(), 2413)!;
    expect(m.ids).toEqual([2408, 2409, 2410, 2411, 2413]);
    expect(m.lines.filter((l) => l.isRoot).map((l) => l.e.eventId)).toEqual([2413]);
    expect(m.lines.filter((l) => l.startedHere).map((l) => l.e.eventId)).toEqual([2408]);
    expect(m.missing).toEqual([]);
    expect(m.evidence.map((l) => l.e.eventId)).toEqual([2408, 2409]);
    expect(m.lines.find((l) => l.e.eventId === 2411)!.transition).toBe("state: waiting → overdue");
    expect(m.lines.find((l) => l.isRoot)!.text).toBe("No answer from Beth Young by 2026-10-14");      // no instruction in history
  });

  it("a cause the chain does not contain is reported as missing — never invented, never 'started here'", () => {
    const m = chainModel(chain.slice(2), 2413)!;                                    // Core no longer has 2408/2409
    expect(m.ids).toEqual([2410, 2411, 2413]);
    expect(m.missing).toEqual([2409]);
    expect(m.lines[0]!.missingCauses).toEqual([2409]);
    expect(m.lines[0]!.startedHere).toBe(false);
    expect(m.evidence).toEqual([]);
  });

  it("an internal-testing step stays in the chain (it is Core's chain) but its content is not shown", () => {
    const m = chainModel(chain, 2413, (e) => e.eventId === 2408)!;
    expect(m.ids).toEqual([2408, 2409, 2410, 2411, 2413]);
    expect(m.lines[0]!.text).not.toMatch(/Beth/);
    expect(m.evidence.map((l) => l.e.eventId)).toEqual([2409]);
  });

  it("null when the root is not in what Core returned", () => { expect(chainModel(chain, 1)).toBeNull(); });

  it("headings are past tense and instruction-free", () => {
    expect(headingOf(chain[4]!)).toBe("No answer from Beth Young by 2026-10-14");
    expect(headingOf(ev({ class: "workflow.invoked", after: { what: "engine:tick", trigger: "interval" } }))).toBe("Finagai's regular 5-minute check ran");
    expect(headingOf(ev({ class: "workflow.invoked", after: { what: "mac:/control/decision" } }))).toBe("The Mac helper passed on your reply");
  });
});

describe("ownerNow — only the authoritative snapshot says who owns it now", () => {
  const open = need(E, career.id, { key: `overdue:${F}:2026-10-14`, followup_id: F, summary: SUM });
  it("open in Needs you → Julian, with the static can / only-you-can copy", () => {
    const s = snapshot({ areas: [career], needsJulian: [open] });
    const o = ownerNow(chain[4]!, deriveCommand(s, null, Date.parse("2026-10-15T12:00:00Z")), s);
    expect(o).toEqual(expect.objectContaining({ kind: "julian", label: "Only you can do this" }));
    expect(o.kind === "julian" && o.cc?.only).toMatch(/nudge/);
    // the wait's own event finds the same open decision (its follow-up is the decision's subject)
    expect(ownerNow(chain[3]!, deriveCommand(s, null, 0), s).kind).toBe("julian");
  });
  it("resolved → nothing open now, even though the recorded event said nextOwner julian", () => {
    const s = snapshot({ areas: [career] });
    expect(ownerNow(chain[4]!, deriveCommand(s, null, 0), s)).toEqual({ kind: "none" });
  });
  it("a wait Finagai is watching; a Mac task by its number; an internal-Area decision is never Julian's here", () => {
    const s = snapshot({ areas: [career, area("a-test", "Finagai Test", { internal: true })], waits: [wait(F, career.id)], tasks: [{ code: 137, status: "active", verification_status: null, awaiting_kind: null, request: "x", updated_at: "" }],
      needsJulian: [need("int", "a-test", { key: `overdue:${F}:x`, followup_id: F })] });
    const v = deriveCommand(s, null, 0);
    expect(ownerNow(chain[3]!, v, s)).toEqual(expect.objectContaining({ kind: "wait" }));
    expect(ownerNow(ev({ class: "escalation.resolved", entity: { type: "escalation", id: "x" }, after: { key: "mac:137:step:406@control_task:t" } }), v, s)).toEqual(expect.objectContaining({ kind: "task" }));
  });
});

describe("recordFacts", () => {
  it("shows authorization, verification and confidence only when the event carries them", () => {
    expect(recordFacts(ev({ class: "lesson.learned", actor: "learning", confidence: 0.82, verified: null })).map((f) => `${f.label}: ${f.value}`)).toEqual(["Recorded by: Finagai's learning pass", "Confidence: 82%"]);
    expect(recordFacts(ev({ class: "task.completed", actor: "j6", humanAuthorized: true, verified: false })).map((f) => f.label)).toEqual(["Recorded by", "Authorization", "Verification"]);
  });
});

describe("loadWhy — two GETs, nothing else", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  it("an object resolves to its latest event, then that event's chain", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const f = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return url.startsWith("/api/live/history") ? ok({ events: [chain[4]] }) : ok({ chain }); }) as unknown as typeof fetch;
    const d = await loadWhy({ kind: "object", type: "escalation", id: E }, f);
    expect(d.rootId).toBe(2413);
    expect(calls.map((c) => c[0])).toEqual([`/api/live/history?entityType=escalation&entityId=${E}&order=desc&limit=1`, "/api/live/chain/2413"]);
    for (const [, init] of calls) expect(init?.method ?? "GET").toBe("GET");
  });
  it("fails as not found / signed out / offline — never with made-up content", async () => {
    const fails = async (f: typeof fetch) => { try { await loadWhy({ kind: "event", id: 5 }, f); return "loaded"; } catch (e) { return (e as WhyLoadError).reason; } };
    expect(await fails((async () => ok({ chain: [] })) as unknown as typeof fetch)).toBe("not_found");
    expect(await fails((async () => new Response("", { status: 401 })) as unknown as typeof fetch)).toBe("signed_out");
    expect(await fails((async () => { throw new TypeError("network"); }) as unknown as typeof fetch)).toBe("offline");
    expect(await fails((async () => new Response("", { status: 502 })) as unknown as typeof fetch)).toBe("offline");
  });
});
