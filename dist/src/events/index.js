import { careerModule } from "./career.js";
import { genericModule } from "./generic.js";
import { runTick } from "./engine.js";
/** Generic watchers/reactions first, then each Area's plug-in. A new Area adds a module here — the engine is unchanged. */
export const AREA_MODULES = [genericModule, careerModule];
export const TICK_EVERY_MS = 5 * 60_000;
export function startEventLoop(pool, google, notify, log) {
    const run = async () => {
        try {
            const r = await runTick(pool, { google, now: new Date(), dryRun: false, log }, { modules: AREA_MODULES, notify }, "interval");
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