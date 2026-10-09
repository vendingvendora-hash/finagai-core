/**
 * Phase 0A regression: helper ↔ Core capability payload drift (audit 2026-10-09: helper sent screen/files,
 * Core read screenCapture/filesystem → mac.screen/mac.filesystem stuck at "unknown"; router compared
 * booleans to "PASS" → healthy rungs skipped).
 */
import { describe, it, expect } from "vitest";
// @ts-ignore - plain ESM helper module
import { DOCTOR_CHECK_KEYS, capabilitiesFromDoctor, macDoctor } from "../../helper/mac-perception.mjs";
import { MAC_CAPABILITY_KEYS, normalizeCapabilities } from "../../src/mac/capabilities.js";
import { route } from "../../src/mac/router.js";

const okRun = async () => ({ stdout: "Google Chrome\tTitle" });

describe("Mac capability contract (Phase 0A)", () => {
  it("every doctor check declares a canonical key, and every canonical key is probed", () => {
    const keys = Object.values(DOCTOR_CHECK_KEYS) as string[];
    for (const k of keys) expect(MAC_CAPABILITY_KEYS as readonly string[]).toContain(k);
    for (const k of MAC_CAPABILITY_KEYS) expect(keys).toContain(k);
  });
  it("a real doctor run (fake shell) yields only canonical keys", async () => {
    const doc = await macDoctor(okRun, "/tmp/x.png");
    for (const c of doc.checks) expect(c.key, c.name).toBeDefined();
    const caps = capabilitiesFromDoctor(doc) as Record<string, string>;
    for (const k of Object.keys(caps)) expect(MAC_CAPABILITY_KEYS as readonly string[]).toContain(k);
    expect(caps.screenCapture).toBe("PASS");
    expect(caps.filesystem).toBe("PASS");
  });
  it("normalizes the live runtime-12 payload (booleans, legacy keys)", () => {
    const live = { screen: true, files: true, accessibility: true, accessibilityTree: true, activeWindow: true, browser: true, clipboard: true };
    const n = normalizeCapabilities(live);
    expect(n.screenCapture).toBe("PASS");
    expect(n.filesystem).toBe("PASS");
    expect(n.accessibility).toBe("PASS");
    expect(Object.keys(n)).not.toContain("screen");
  });
  it("canonical key wins over legacy; unknown values stay unknown", () => {
    expect(normalizeCapabilities({ screen: false, screenCapture: "PASS" }).screenCapture).toBe("PASS");
    expect(normalizeCapabilities({ filesystem: "maybe" }).filesystem).toBe("unknown");
  });
  it("router no longer skips healthy rungs when the helper reports booleans", () => {
    const r = route("open TextEdit and type hello", { accessibility: true, screen: true } as never);
    expect(r.unavailable).toEqual([]);
    expect(r.primary).toBe("app_scripting");
    const blocked = route("open TextEdit and type hello", { accessibility: false } as never);
    expect(blocked.unavailable).toContain("app_scripting");
  });
});
