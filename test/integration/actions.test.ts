/**
 * Phase 1B (corrected) — logical-action idempotency on real Postgres. The five required scenarios.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { claimAction, reportAction, IN_FLIGHT_MS } from "../../src/concierge/actions.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
const art = "11111111-1111-4111-8111-111111111111";
const req = (ref: string, to = "+15550001") => ({ requestRef: ref, operation: "send_artifact", artifactId: art, recipient: to });
const age = async (id: string, ms: number) => pool!.query(`UPDATE outbound_action SET requested_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [id, String(ms)]);

describe.skipIf(!pool)("outbound action idempotency (logical request scope)", () => {
  afterAll(async () => { await pool?.end(); });

  it("1. retries of ONE request → one externally visible send", async () => {
    const ref = `guid-retry-${Date.now()}`;
    const a = await claimAction(pool!, req(ref)); expect(a.decision).toBe("execute");
    await reportAction(pool!, a.action.id, "accepted");
    for (let i = 0; i < 3; i++) expect((await claimAction(pool!, req(ref))).decision).toBe("already_done");
  });

  it("2. worker restart mid-send (claimed, no ack) → reconcile from evidence, NOT a blind resend", async () => {
    const ref = `guid-restart-${Date.now()}`;
    const a = await claimAction(pool!, req(ref));
    expect((await claimAction(pool!, req(ref))).decision).toBe("in_flight");      // the original worker may still be sending
    await age(a.action.id, IN_FLIGHT_MS + 1000);                                  // worker died; lease-like window passed
    const pool2 = createPool(url!);                                               // a restarted worker / fresh Core process
    try { expect((await claimAction(pool2, req(ref))).decision).toBe("reconcile"); } finally { await pool2.end(); }
  });

  it("3. Core retry / concurrent duplicate claims → exactly one execute", async () => {
    const ref = `guid-concurrent-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => claimAction(pool!, req(ref))));
    expect(results.filter((r) => r.decision === "execute").length).toBe(1);
  });

  it("4. uncertain acknowledgement → reconciliation records evidence; state is monotonic; definite failure allows a bounded retry", async () => {
    const ref = `guid-uncertain-${Date.now()}`;
    const a = await claimAction(pool!, req(ref)); await age(a.action.id, IN_FLIGHT_MS + 1000);
    const r = await claimAction(pool!, req(ref)); expect(r.decision).toBe("reconcile");
    const row = await reportAction(pool!, a.action.id, "outgoing_observed", { rowid: 123, delivered: false });
    expect(row.state).toBe("outgoing_observed");
    expect((await reportAction(pool!, a.action.id, "accepted")).state).toBe("outgoing_observed");   // never downgraded
    expect((await claimAction(pool!, req(ref))).decision).toBe("already_done");
    const ref2 = `guid-failed-${Date.now()}`;
    const f = await claimAction(pool!, req(ref2)); await reportAction(pool!, f.action.id, "failed", { error: "osascript" });
    const again = await claimAction(pool!, req(ref2)); expect(again.decision).toBe("execute"); expect(again.action.attempts).toBe(2);
  });

  it("5. a NEW explicit request to send the same artifact to the same recipient is allowed", async () => {
    const first = await claimAction(pool!, req(`guid-A-${Date.now()}`)); await reportAction(pool!, first.action.id, "delivered");
    const second = await claimAction(pool!, req(`guid-B-${Date.now()}`));   // "send it to Santiago again" = new message guid
    expect(second.decision).toBe("execute");
  });
});
