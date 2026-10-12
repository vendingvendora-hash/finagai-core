import { careerModule } from "./career.js";
import { genericModule } from "./generic.js";
import { learningModule } from "./learning.js";
import { runTick } from "./engine.js";
import { liveAcceptance } from "../live/acceptance.js";
import { runStateCanary } from "../live/canary.js";
/** Generic watchers/reactions first, then each Area's plug-in. A new Area adds a module here — the engine is unchanged. */
export const AREA_MODULES = [genericModule, learningModule, careerModule];
/** Workflows a stated routing correction may send mail to: Area workflows only (never waits, deadlines or learning). */
export const ROUTABLE_WORKFLOWS = AREA_MODULES.flatMap((m) => m.subscriptions.filter((s) => s.area !== "*").map((s) => s.workflow)).filter((w, i, a) => a.indexOf(w) === i);
export const TICK_EVERY_MS = 5 * 60_000;
/** Phase 8 (ADR-088): how often the live self-check runs inside the loop. */
export const SELF_CHECK_EVERY_MS = 60 * 60_000;
/** Phase 8 (ADR-088, increment 2): the internal state-path canary runs once a day. */
export const CANARY_EVERY_MS = 24 * 60 * 60_000;
export function startEventLoop(pool, google, notify, log) {
    const version = process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? "dev";
    const selfCheck = { everyMs: SELF_CHECK_EVERY_MS, version,
        check: async () => { const a = await liveAcceptance(pool, { version }); return { allPass: a.allPass, verdict: a.verdict }; } };
    const run = async () => {
        try {
            const r = await runTick(pool, { google, now: new Date(), dryRun: false, log }, { modules: AREA_MODULES, notify, reliability: selfCheck, canary: { everyMs: CANARY_EVERY_MS, run: (now) => runStateCanary(pool, now) } }, "interval");
            if (!r.skipped)
                log("event tick", { events: r.events.length, routed: r.events.filter((e) => e.routes.length).length, workflows: r.workflows.map((w) => `${w.name}:${w.ok ? "ok" : "failed"}`),
                    opened: r.escalations.opened.length, resolved: r.escalations.resolved.length });
        }
        catch (e) {
            log("event tick failed", { error: String(e?.message ?? e).slice(0, 200) });
        }
    };
    const first = setTimeout(run, 90_000);
    first.unref();
    const every = setInterval(run, TICK_EVERY_MS);
    every.unref();
    return () => { clearTimeout(first); clearInterval(every); };
}
export { runTick, proactivityStatus } from "./engine.js";
//# sourceMappingURL=index.js.map