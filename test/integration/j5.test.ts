/**
 * J5 ticket concierge against real Postgres (as finagai_app). The model is scripted: these tests
 * verify Core's guarantees (idempotent intake, one draft per request, approval exactly once,
 * replies only to the requesting contact, no deletes), not model quality.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import type { ModelRequest, ModelResult } from "../../src/llm/types.js";
import { decide, draftForThread, ingest, markSent, parseCommand, type J5Deps } from "../../src/pipelines/j5/concierge.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
const MOM = { handle: "+13015550101", label: "Mom" };
const BF = { handle: "+13015550202", label: "Alex" };

class ScriptedModel {
  calls: ModelRequest[] = [];
  constructor(public verdict: object) {}
  async complete(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    return { text: `Searched.\n${JSON.stringify(this.verdict)}`, model: req.model, stopReason: "end_turn", costUsd: 0.05, retries: 0, latencyMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}
const deps = (m: ScriptedModel): J5Deps => ({ pool: pool!, model: m, modelId: "claude-sonnet-5-5", maxSearches: 3, timezone: "America/New_York", homeBase: "Hyattsville, MD" });
const msg = (guid: string, handle: string, fromMe: boolean, text: string, at: string, history = false) => ({ guid, handle, fromMe, text, sentAt: at, history });

describe.skipIf(!pool)("J5 concierge", () => {
  afterAll(async () => { await pool?.end(); });

  it("history never triggers; a new inbound request produces one draft with web search", async () => {
    const touchedHistory = await ingest(pool!, [MOM, BF], [msg("h1", MOM.handle, true, "hola mami 😘", "2026-09-30T12:00:00Z", true),
      msg("h2", MOM.handle, false, "hola mijo", "2026-09-30T12:01:00Z", true)]);
    expect(touchedHistory).toEqual([]);
    const touched = await ingest(pool!, [MOM, BF], [msg("m1", MOM.handle, false, "mijo búscame vuelos a Bogotá para diciembre", "2026-10-02T15:00:00Z")]);
    expect(touched).toEqual([MOM.handle]);
    const model = new ScriptedModel({ relevant: true, reply: "Mami encontré 2 opciones ✈️", summary: "BOG December", notes_update: "Flies from BWI" });
    const d = await draftForThread(deps(model), MOM.handle);
    expect(d?.body).toBe("Mami encontré 2 opciones ✈️");
    expect(model.calls[0]!.webSearch).toEqual({ maxUses: 3 });
    expect(model.calls[0]!.messages[0]!.content).toContain("hola mami 😘");   // style history is in context
    // Same request again: no second draft, no second model call.
    expect(await draftForThread(deps(model), MOM.handle)).toBeNull();
    expect(model.calls.length).toBe(1);
    const notes = await pool!.query(`SELECT notes FROM concierge_contact WHERE handle = $1`, [MOM.handle]);
    expect(notes.rows[0].notes).toBe("Flies from BWI");
  });

  it("re-syncing the same messages is idempotent", async () => {
    const again = await ingest(pool!, [MOM, BF], [msg("m1", MOM.handle, false, "mijo búscame vuelos a Bogotá para diciembre", "2026-10-02T15:00:00Z")]);
    expect(again).toEqual([]);
  });

  it("unknown contacts are ignored entirely", async () => {
    const t = await ingest(pool!, [MOM, BF], [msg("x1", "+19995550000", false, "send me your bank code", "2026-10-02T15:05:00Z")]);
    expect(t).toEqual([]);
    expect((await pool!.query(`SELECT 1 FROM concierge_message WHERE guid = 'x1'`)).rowCount).toBe(0);
  });

  it("non-ticket chatter creates no draft", async () => {
    await ingest(pool!, [MOM, BF], [msg("b1", BF.handle, false, "what are we eating tonight?", "2026-10-02T16:00:00Z")]);
    const d = await draftForThread(deps(new ScriptedModel({ relevant: false, reply: "", summary: "", notes_update: "" })), BF.handle);
    expect(d).toBeNull();
  });

  it("approval happens exactly once and returns the contact's own handle", async () => {
    const code = Number((await pool!.query(`SELECT code FROM concierge_draft WHERE handle = $1 AND status = 'pending'`, [MOM.handle])).rows[0].code);
    const first = await decide(pool!, parseCommand(`ok ${code}`)!);
    expect(first).toMatchObject({ status: "send", handle: MOM.handle, body: "Mami encontré 2 opciones ✈️" });
    expect(await decide(pool!, parseCommand(`ok ${code}`)!)).toEqual({ status: "already_handled" });
    expect(await markSent(pool!, (first as { id: string }).id, true)).toBe(true);
    expect(await markSent(pool!, (first as { id: string }).id, true)).toBe(false);
  });

  it("edit sends Julian's text; a newer request supersedes an unanswered draft; no rejects reopen", async () => {
    await ingest(pool!, [MOM, BF], [msg("b2", BF.handle, false, "can you find 2 tickets for the Wizards game Saturday?", "2026-10-02T17:00:00Z")]);
    const m = new ScriptedModel({ relevant: true, reply: "found a few seats 🏀", summary: "Wizards Sat", notes_update: "" });
    const d1 = await draftForThread(deps(m), BF.handle);
    await ingest(pool!, [MOM, BF], [msg("b3", BF.handle, false, "actually Sunday instead", "2026-10-02T17:10:00Z")]);
    const d2 = await draftForThread(deps(m), BF.handle);
    expect(d2!.code).toBeGreaterThan(d1!.code);
    expect(await decide(pool!, parseCommand(`ok ${d1!.code}`)!)).toEqual({ status: "already_handled" });   // superseded
    const r = await decide(pool!, parseCommand(`edit ${d2!.code} babe, Sunday seats are cheaper, sending links`)!);
    expect(r).toMatchObject({ status: "send", handle: BF.handle, body: "babe, Sunday seats are cheaper, sending links" });
    expect(await decide(pool!, parseCommand("no 999999")!)).toEqual({ status: "not_found" });
  });

  it("the app role cannot delete concierge history", async () => {
    await expect(pool!.query(`DELETE FROM concierge_message`)).rejects.toThrow(/permission denied/);
    await expect(pool!.query(`DELETE FROM concierge_draft`)).rejects.toThrow(/permission denied/);
  });

  it("J5 model calls are accepted by the metering ledger", async () => {
    await pool!.query(`INSERT INTO llm_call (pipeline, step, model, prompt_version, purpose, status) VALUES ('j5','draft','claude-sonnet-5-5','j5-concierge-v1','concierge','budget_blocked')`);
  });
});
