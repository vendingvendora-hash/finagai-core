/**
 * ADR-087 — Live State contract invariants that need no database: every event action Finagai writes is classified
 * (no silent "other.*"), payloads are sanitized, bursts coalesce without breaking resume, and the stream code can
 * only write its own ordering index.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_ACTIONS, classify } from "../../src/live/ontology.js";
import { coalesce, sanitize, type LiveEvent } from "../../src/live/stream.js";

const SRC = resolve(__dirname, "../../src");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
/** Every literal action name written anywhere in src. */
function writtenActions(): Set<string> {
  const out = new Set<string>();
  for (const f of files(SRC)) {
    const t = readFileSync(f, "utf8");
    for (const m of t.matchAll(/action:\s*"([a-z_]+)"/g)) out.add(m[1]!);
    for (const m of t.matchAll(/\bev\("([a-z_]+)"/g)) out.add(m[1]!);
    for (const m of t.matchAll(/action: `lesson_\$\{status\}`/g)) { void m; ["lesson_approved", "lesson_rejected", "lesson_active"].forEach((a) => out.add(a)); }
  }
  for (const m of readFileSync(join(SRC, "pipelines/j2/capture.ts"), "utf8").matchAll(/\("(create|update|supersede|conflict_open|proposal_open)", "/g)) out.add(m[1]!);
  return out;
}

describe("ontology", () => {
  it("every action Finagai writes is classified into a real domain (nothing falls through to other.*)", () => {
    const missing = [...writtenActions()].filter((a) => classify({ action: a, entity_type: null, after: null, before: null, approval_id: null }).domain === "other");
    expect(missing).toEqual([]);
    expect(KNOWN_ACTIONS.length).toBeGreaterThan(60);
  });
  it("classification reads the stored row (pure): ownership, verification, confidence", () => {
    expect(classify({ action: "exception_opened", entity_type: "operating_exception", after: { owner: "julian" }, before: null, approval_id: null })).toEqual(expect.objectContaining({ class: "exception.opened", nextOwner: "julian" }));
    expect(classify({ action: "control_task_done", entity_type: "control_task", after: { verification: "verified" }, before: null, approval_id: null }).verified).toBe(true);
    // Phase 8 live: call_tool's routing record (no outcome) was classified tool.failed — it is a routing note
    const row = (after: Record<string, unknown>) => ({ action: "tool_called", entity_type: "tool", after, before: null, approval_id: null });
    expect(classify(row({ tool: "call_tool", routedTo: "tell_me_when" })).class).toBe("tool.routed");
    expect(classify(row({ tool: "call_tool", routedTo: "tell_me_when", outcome: "routed" })).class).toBe("tool.routed");
    expect(classify(row({ tool: "waiting_on", outcome: "ok" })).class).toBe("tool.succeeded");
    expect(classify(row({ tool: "waiting_on", outcome: "error" })).class).toBe("tool.failed");
    // Phase 8 failure mining (live 2026-10-13): a tool's legacy second record of its domain result is an answer, not a failure
    expect(classify(row({ tool: "resolve_reference", outcome: "none" }))).toEqual(expect.objectContaining({ class: "tool.answered", lowValue: true }));
    expect(classify(row({ tool: "control_mac", outcome: "mac_offline" })).class).toBe("tool.answered");
    expect(classify(row({ tool: "resolve_reference", outcome: "ok", result: "none" })).class).toBe("tool.succeeded");
    expect(classify({ action: "project_archived", entity_type: "project", after: { archived_at: "x" }, before: { archived_at: null }, approval_id: null }).class).toBe("entity.archived");
    // the self-check verdict and job runs are classified
    expect(classify({ action: "reliability_checked", entity_type: null, after: { allPass: false, failing: ["ordering"] }, before: null, approval_id: null }).class).toBe("system.check_failed");
    expect(classify({ action: "reliability_checked", entity_type: null, after: { allPass: false, failing: [], pending: ["emailToStateChain"] }, before: null, approval_id: null })).toEqual(expect.objectContaining({ class: "system.checked", lowValue: true }));
    expect(classify({ action: "job_finished", entity_type: null, after: { status: "failed" }, before: null, approval_id: null })).toEqual(expect.objectContaining({ class: "workflow.failed", nextOwner: "finagai" }));
    expect(classify({ action: "lesson_learned", entity_type: "lesson", after: { key: "perf:tool:x", confidence: 0.9 }, before: null, approval_id: null })).toEqual(expect.objectContaining({ class: "capability.measured", confidence: 0.9 }));
    expect(classify({ action: "lesson_proposed", entity_type: "lesson", after: { effect: { type: "procedure" } }, before: null, approval_id: null }).class).toBe("procedure.discovered");
    expect(classify({ action: "tool_called", entity_type: "tool", after: { outcome: "ok" }, before: null, approval_id: null })).toEqual(expect.objectContaining({ class: "tool.succeeded", lowValue: true }));
    expect(classify({ action: "brand_new_action", entity_type: null, after: null, before: null, approval_id: null }).class).toBe("other.brand_new_action");   // still streamed
  });
});

describe("safety and delivery helpers", () => {
  it("sanitize removes secret keys and secret-looking values at any depth and bounds sizes", () => {
    const s = sanitize({ password: "p", nested: { apiKey: "k", list: [{ refresh_token: "t" }], note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }, jwt: "eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmno", big: "x".repeat(2000), ok: 3 }) as Record<string, unknown>;
    expect(s.password).toBe("[redacted]");
    expect((s.nested as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect(JSON.stringify(s)).not.toMatch(/abcdefghijklmnopqrstuvwxyz|eyJabcdefghijk\./);
    expect((s.big as string).length).toBe(500);
    expect(s.ok).toBe(3);
  });
  it("redaction matches secret WORDS, not substrings (Phase 8 live: the self-check's allPass/passed were redacted)", () => {
    const s = sanitize({ allPass: true, passed: 10, pass: false, inputTokens: 120, maxTokens: 900, outputTokens: 30, passkey_enrolled: 1,
      refreshTokens: ["r1"], pageToken: "p", sessionSecret: "s", client_secret: "c", privateKey: "k", api_key: "a", oauthToken: "o", passcode: "1234", challenge: "x" }) as Record<string, unknown>;
    expect(s).toEqual(expect.objectContaining({ allPass: true, passed: 10, pass: false, inputTokens: 120, maxTokens: 900, outputTokens: 30, passkey_enrolled: 1 }));
    for (const k of ["refreshTokens", "pageToken", "sessionSecret", "client_secret", "privateKey", "api_key", "oauthToken", "passcode", "challenge"]) expect(s[k], k).toBe("[redacted]");
  });
  it("coalescing keeps the last seq of a burst (resume is never broken) and leaves everything else alone", () => {
    const ev = (seq: number, cls: string, lowValue: boolean): LiveEvent => ({ v: 1, seq, eventId: seq, at: "", class: cls, domain: cls.split(".")[0] as never, verb: "", action: "", actor: "", area: null,
      entity: { type: "tool", id: null }, summary: cls, before: null, after: null, cause: { correlationId: null, eventIds: [], requestId: null }, nextOwner: null, humanAuthorized: false, verified: null, confidence: null, lowValue });
    const out = coalesce([ev(1, "wait.started", false), ev(2, "tool.succeeded", true), ev(3, "tool.succeeded", true), ev(4, "tool.succeeded", true), ev(5, "exception.opened", false), ev(6, "tool.succeeded", true)]);
    expect(out.map((e) => e.seq)).toEqual([1, 4, 5, 6]);
    expect(out[1]!.coalesced).toEqual({ count: 3, firstSeq: 2 });
  });
});

describe("read-only trust boundary (structural)", () => {
  const live = (f: string) => readFileSync(join(SRC, "live", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  it("the stream code only appends to its own ordering index — never operational state, never a DELETE", () => {
    const writes = readdirSync(join(SRC, "live")).flatMap((f) => [...live(f).matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`));
    expect(new Set(writes)).toEqual(new Set(["INSERT INTO live_event"]));   // archive-only: no DELETE, not even for retention
    expect(live("http.ts")).not.toMatch(/\bappendEvent\(|from "\.\.\/(governance|approval|pipelines)|createTask\(/);
  });
  it("the HTTP surface is GET-only", () => {
    expect(live("http.ts")).toMatch(/if \(req\.method !== "GET"\) \{ res\.writeHead\(405/);
  });
});
