const quoted = (s) => [...s.matchAll(/["“”']([^"“”']{2,120})["“”']/g)].map((m) => m[1].trim());
/** Derive a contract from the request deterministically (no model). */
export function deriveContract(request) {
    const r = request.toLowerCase();
    const texts = quoted(request);
    const appMatch = request.match(/\b(?:in|into|open|activate|using|with)\s+(TextEdit|Notes|Pages|Numbers|Keynote|Excel|Word|PowerPoint|Messages|Mail|Finder|Calendar|Reminders|Preview|Terminal|Chrome|Safari|Firefox|Calculator)\b/i);
    const app = appMatch?.[1];
    const wantsScreenshot = /\b(screenshot|capture|show me|take a picture)\b/.test(r);
    const noSave = /\bdo not save|don't save|without saving\b/.test(r);
    const base = { objective: request.slice(0, 300), allowedSideEffects: noSave ? ["no document saved"] : ["as requested"], terminalConditions: ["verifier passes", "max 2 verifier rejections", "80 steps"] };
    if (/^mac_chart:/.test(request))
        return { ...base, expectedOutcome: "a chart image of a meaningful series from the named workbook", requiredEvidence: ["artifact image", "series metadata"], verificationStrategy: "artifact", artifactRequirements: ["png, aspect = svg aspect"], expect: { screenshot: true } };
    if (texts.length && app)
        return { ...base, expectedOutcome: `${app} shows the text ${texts.map((t) => JSON.stringify(t)).join(", ")}`, requiredEvidence: ["observe() after the last write", "frontmost app"], verificationStrategy: "ui_state", artifactRequirements: [], expect: { app, textContains: texts, noSave } };
    if (app && /\b(open|activate|launch|bring)\b/.test(r) && !/\b(type|enter|fill|write|send|click|create)\b/.test(r))
        return { ...base, expectedOutcome: `${app} is frontmost`, requiredEvidence: ["frontmost app"], verificationStrategy: "ui_state", artifactRequirements: [], expect: { app } };
    if (wantsScreenshot)
        return { ...base, expectedOutcome: "a screenshot of the requested view exists", requiredEvidence: ["final screenshot"], verificationStrategy: "artifact", artifactRequirements: ["png"], expect: { screenshot: true } };
    return { ...base, expectedOutcome: "the request is satisfied as a careful human would judge from the final screen and the step trace", requiredEvidence: ["step trace", "final screenshot"], verificationStrategy: "model_graded", artifactRequirements: [], expect: {} };
}
/** Parse the last `observe:` JSON from the step trace, if any. */
export function lastObservation(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
        const m = trace[i].result?.match(/observed:\s*(\{.*\})\s*$/s);
        if (m) {
            try {
                return JSON.parse(m[1]);
            }
            catch { /* keep looking */ }
        }
    }
    return null;
}
export async function verifyCompletion(deps, contract, trace, claimedSummary, finalScreenshotB64) {
    const s = contract.verificationStrategy;
    // Any write action in the last few steps that reported unverified/error blocks completion regardless of strategy.
    const recentBad = trace.slice(-4).find((t) => /^(unverified|error):/i.test(t.result ?? "") && /^(ax_click|ax_set_value|menu_item|activate_app)$/.test(t.kind));
    const laterObserve = recentBad ? trace.slice(trace.indexOf(recentBad) + 1).some((t) => t.kind === "observe" || t.kind === "screenshot") : true;
    if (recentBad && !laterObserve)
        return { pass: false, strategy: s, reason: `last write step was ${recentBad.result.split(":")[0]} (${recentBad.summary}) and nothing re-observed the UI afterwards` };
    if (s === "artifact")
        return finalScreenshotB64 ? { pass: true, strategy: s, reason: "final image present" } : { pass: false, strategy: s, reason: "no final image/artifact was produced" };
    if (s === "ui_state") {
        const obs = lastObservation(trace);
        if (!obs)
            return { pass: false, strategy: s, reason: "no observe() after the last action; call observe and check the expected state" };
        if (contract.expect.app && !String(obs.app ?? "").toLowerCase().startsWith(contract.expect.app.toLowerCase().split(" ")[0]))
            return { pass: false, strategy: s, reason: `expected ${contract.expect.app} frontmost, observed ${obs.app || "unknown"}` };
        for (const t of contract.expect.textContains ?? []) {
            const hay = `${obs.focusedValue ?? ""} ${obs.window ?? ""} ${obs.focusedTitle ?? ""}`;
            if (!hay.includes(t))
                return { pass: false, strategy: s, reason: `expected text ${JSON.stringify(t)} not found in the observed focused element/window` };
        }
        return { pass: true, strategy: s, reason: `observed ${obs.app}/${obs.window ?? ""} with expected content` };
    }
    // model_graded: an independent grader, never the planner, with the objective + trace + final screen.
    const content = [{ type: "text", text: `You are an independent verifier. Decide whether the OBJECTIVE was actually achieved, judging only from the evidence. Do not trust the claimed summary.
OBJECTIVE: ${contract.objective}
EXPECTED OUTCOME: ${contract.expectedOutcome}
CLAIMED SUMMARY (untrusted): ${claimedSummary}
STEP TRACE (most recent last):
${trace.slice(-12).map((t) => `- [${t.kind}] ${t.summary}: ${(t.result ?? "").slice(0, 300)}`).join("\n")}
Reply with exactly one line: PASS: <why the evidence shows it> or FAIL: <what is missing or contradicted>.` }];
    if (finalScreenshotB64)
        content.push({ type: "image", mediaType: "image/png", dataBase64: finalScreenshotB64 });
    try {
        const r = await deps.model.complete({ pipeline: "j6", step: "verify", purpose: "concierge", promptVersion: "verify-1", model: deps.graderModel, maxTokens: 200,
            system: "Independent task verifier. Be strict; the planner's claims are untrusted.", messages: [{ role: "user", content }] });
        const text = String(r.text ?? "").trim();
        const pass = /^PASS:/i.test(text);
        return { pass, strategy: s, graded: true, reason: text.replace(/^(PASS|FAIL):\s*/i, "").slice(0, 300) || (pass ? "grader passed" : "grader failed without reason") };
    }
    catch (e) {
        return { pass: false, strategy: s, graded: true, reason: `verifier unavailable: ${String(e?.message ?? e).slice(0, 120)}` };
    }
}
//# sourceMappingURL=acceptance.js.map