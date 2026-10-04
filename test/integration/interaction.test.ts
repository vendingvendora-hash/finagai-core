/**
 * Interaction reliability (product mandate). Reproduces the screenshot failure and locks the fixes:
 * durable artifact continuity (survives restart), inbound idempotency, outbound-once.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { registerArtifact, resolveRecentArtifact, markArtifactSent, claimInbound, finishInbound } from "../../src/concierge/interaction.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

describe.skipIf(!pool)("Interaction reliability (ADR-061)", () => {
  afterAll(async () => { await pool?.end(); });

  // THE SCREENSHOT BUG: chart made -> "send Santiago" must resolve it, even across a 'restart'.
  it("I08/I09: 'send' resolves the recent chart durably, surviving a simulated restart", async () => {
    const made = await registerArtifact(pool!, { kind: "chart", storageRef: `/tmp/chart-${Date.now()}.png`, summary: "Altarum trend", conversation: "self" });
    // simulate restart: nothing in process memory; resolve purely from the DB
    const resolved = await resolveRecentArtifact(pool!, { conversation: "self", kind: "chart" });
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(made.id);                 // the exact chart, not "no recent chart"
    expect(resolved!.storageRef).toBe(made.storageRef);
    await markArtifactSent(pool!, resolved!.id);
    // once sent, it is no longer the pending 'ready' one
    const after = await resolveRecentArtifact(pool!, { conversation: "self", kind: "chart" });
    expect(after?.id === made.id && after?.state === "ready").toBeFalsy();
  });

  // I03: the same inbound GUID delivered many times executes once.
  it("I03: duplicate inbound GUID is claimed once", async () => {
    const guid = `guid-${Date.now()}`;
    const first = await claimInbound(pool!, guid, "self");
    expect(first.claim).toBe(true);
    // 4 duplicate deliveries while still 'claimed' -> all refused
    for (let i = 0; i < 4; i++) { const dup = await claimInbound(pool!, guid, "self"); expect(dup.claim).toBe(false); }
    await finishInbound(pool!, guid, true, "sent");
    const afterDone = await claimInbound(pool!, guid, "self");
    expect(afterDone.claim).toBe(false);                // done -> never re-executes
    expect(afterDone.state).toBe("done");
  });

  // I05: a crashed worker's claim is reclaimable after the lease expires (recovery, not silence).
  it("I05: an expired claim is recoverable by another worker", async () => {
    const guid = `crash-${Date.now()}`;
    expect((await claimInbound(pool!, guid, "self", 60_000)).claim).toBe(true);
    // not yet expired -> not reclaimable
    expect((await claimInbound(pool!, guid, "self", 60_000)).claim).toBe(false);
    // force the claim old, then a tiny lease makes it reclaimable
    await pool!.query(`UPDATE inbound_message SET claimed_at = now() - interval '10 minutes' WHERE guid = $1`, [guid]);
    expect((await claimInbound(pool!, guid, "self", 1000)).claim).toBe(true);   // recovered
  });

  it("Phase 1B: an artifact can be claimed for sending to a recipient exactly once within 24h", async () => {
    const a = await registerArtifact(pool!, { kind: "chart", storageRef: "/tmp/x.png", conversation: "self", summary: "t" } as never);
    const claim = async () => pool!.query(`UPDATE artifact SET send_claimed_at = now(), sent_to = $2, state = 'sending'
      WHERE id = $1 AND NOT (state IN ('sending','sent') AND sent_to = $2 AND coalesce(sent_at, send_claimed_at) > now() - interval '24 hours') RETURNING id`, [a.id, "+1555"]);
    expect((await claim()).rowCount).toBe(1);
    expect((await claim()).rowCount).toBe(0);                                  // second attempt refused
    await pool!.query(`UPDATE artifact SET state = 'sent', sent_at = now(), send_verified = true WHERE id = $1`, [a.id]);
    expect((await claim()).rowCount).toBe(0);                                  // still refused after sent
    const other = await pool!.query(`UPDATE artifact SET send_claimed_at = now(), sent_to = $2, state = 'sending'
      WHERE id = $1 AND NOT (state IN ('sending','sent') AND sent_to = $2 AND coalesce(sent_at, send_claimed_at) > now() - interval '24 hours') RETURNING id`, [a.id, "+1666"]);
    expect(other.rowCount).toBe(1);                                            // a different recipient is a different send
  });
});
