/**
 * Phase 0A — the ONE capability payload shared by the Mac helper and Core.
 *
 * Live defect (audit 2026-10-09): the helper sent `screen`/`files` while Core read `screenCapture`/`filesystem`,
 * so mac.screen and mac.filesystem were permanently "unknown"; and the router compared booleans to "PASS",
 * so healthy accessibility rungs were skipped as "capability probe failed".
 *
 * Contract:
 *  - canonical keys are MAC_CAPABILITY_KEYS; the helper's doctor declares the key for each check
 *    (helper/mac-perception.mjs DOCTOR_CHECK_KEYS) and a unit test fails if either side drifts;
 *  - values are normalized to "PASS" | "FAIL" | "unknown" at the Core boundary (recordHeartbeat), so every
 *    consumer (registry, router, mac_status) reads one shape;
 *  - legacy helpers (runtime ≤12) are accepted through LEGACY_KEYS.
 */
export const MAC_CAPABILITY_KEYS = ["screenCapture", "accessibility", "accessibilityTree", "activeWindow", "filesystem", "browser", "clipboard", "browserDom"];
/** Keys reported from live helper state rather than a doctor check (Phase 1: browserDom = an Operator extension is connected). */
export const LIVE_CAPABILITY_KEYS = ["browserDom"];
/** Keys sent by helpers up to runtime-12. */
export const LEGACY_KEYS = { screen: "screenCapture", files: "filesystem" };
const isKey = (k) => MAC_CAPABILITY_KEYS.includes(k);
export function statusOf(v) {
    if (v === true || v === "PASS" || v === "pass" || v === "true" || v === "granted" || v === "ok")
        return "PASS";
    if (v === false || v === "FAIL" || v === "fail" || v === "false" || v === "denied" || v === "blocked")
        return "FAIL";
    return "unknown";
}
/** Normalize any helper payload (canonical or legacy, boolean or string) to the canonical shape. Unknown keys are dropped. */
export function normalizeCapabilities(raw) {
    const out = {};
    if (!raw || typeof raw !== "object")
        return out;
    // Legacy first, canonical second: a canonical key always wins when both are present.
    for (const [k, v] of Object.entries(raw)) {
        const key = LEGACY_KEYS[k];
        if (key)
            out[key] = statusOf(v);
    }
    for (const [k, v] of Object.entries(raw))
        if (isKey(k))
            out[k] = statusOf(v);
    return out;
}
//# sourceMappingURL=capabilities.js.map