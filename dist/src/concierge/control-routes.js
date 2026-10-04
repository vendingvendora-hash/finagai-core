/**
 * J6 control API (ADR-050). Only the Mac helper calls these, with the same CONCIERGE_HELPER_TOKEN.
 *   POST /control/start     {request} -> {taskCode}            (Julian asked for a task)
 *   POST /control/next      {taskId?|taskCode?, screenshot?, lastResult?} -> next action or approval wait
 *   POST /control/decision  {text:"ok 7"} from Julian's Messages thread
 *   POST /control/ran       {stepId, ok, result}
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { cancelTask, createTask, decideStep, getStep, getTaskResult, parseControlCommand, planNext, recordRun, setResultImage } from "../pipelines/j6/control.js";
import { analyzeWorkbookToChart, rankCandidates } from "../mac/operator.js";
import { registerArtifact, resolveRecentArtifact, markArtifactSent, claimInbound, finishInbound } from "./interaction.js";
import { recordHeartbeat, claimTask, taskProgress, macStatus, workerMayComplete, recordSuccess, sweepStaleTasks } from "../mac/runtime.js";
import { completeForTask, setState as setInteractionState } from "./interactions.js";
import { saveContext } from "../mac/context.js";
const MAX_BODY = 24 * 1024 * 1024; // screenshots + perception
function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
}
async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY)
            throw new Error("body too large");
        chunks.push(c);
    }
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error("expected a JSON object");
    return v;
}
export function helperAuthorized(header, token) {
    if (!token || !header?.startsWith("Bearer "))
        return false;
    const a = createHash("sha256").update(header.slice(7)).digest();
    const b = createHash("sha256").update(token).digest();
    return timingSafeEqual(a, b);
}
export function createControlHandler(deps, token, log) {
    async function taskIdFrom(body) {
        if (typeof body.taskId === "string")
            return body.taskId;
        if (Number.isInteger(body.taskCode)) {
            const r = await deps.pool.query(`SELECT id FROM control_task WHERE code = $1`, [body.taskCode]);
            return r.rows[0]?.id ?? null;
        }
        return null;
    }
    return async function handle(req, res, path) {
        if (!token)
            return json(res, 404, { error: "not_found" });
        if (!helperAuthorized(req.headers.authorization, token))
            return json(res, 401, { error: "unauthorized" });
        if (req.method !== "POST")
            return json(res, 405, { error: "method_not_allowed" });
        try {
            const body = await readJson(req);
            if (path === "/control/start") {
                if (typeof body.request !== "string" || !body.request.trim())
                    return json(res, 422, { error: "request_required" });
                const origin = body.origin === "imessage" ? "imessage" : "chat";
                const t = await createTask(deps.pool, body.request, origin);
                return json(res, 200, { taskId: t.id, taskCode: t.code });
            }
            if (path === "/control/pending") {
                // Starvation-proof order (WO1): unclaimed before claimed-by-others, cheap deterministic tasks
                // (mac_ping, mac_chart) before open-ended J6 drives, newest first. A fresh ping is never stuck
                // behind an old J6 task.
                const r = await deps.pool.query(`SELECT id, code, request FROM control_task WHERE status = 'active'
          AND (claimed_at IS NULL OR lease_until < now())
          AND NOT EXISTS (SELECT 1 FROM control_step s WHERE s.task_id = control_task.id AND s.status IN ('proposed','running'))
          ORDER BY (CASE WHEN request LIKE 'mac_ping%' THEN 0 WHEN request LIKE 'mac_chart:%' THEN 1 ELSE 2 END), created_at DESC LIMIT 5`);
                return json(res, 200, { tasks: r.rows });
            }
            if (path === "/control/next") {
                if (typeof body.taskId === "string" && !(await workerMayComplete(deps.pool, body.taskId, typeof body.workerId === "string" ? body.workerId : null)))
                    return json(res, 409, { error: "not_lease_holder" });
                const taskId = await taskIdFrom(body);
                if (!taskId)
                    return json(res, 404, { error: "task_not_found" });
                const shot = typeof body.screenshot === "string" ? body.screenshot : null;
                const perception = {};
                if (typeof body.pageText === "string")
                    perception.pageText = body.pageText;
                if (typeof body.axTree === "string")
                    perception.axTree = body.axTree;
                if (body.context && typeof body.context === "object") {
                    const c = body.context;
                    perception.context = {
                        ...(typeof c.app === "string" ? { app: c.app } : {}),
                        ...(typeof c.window === "string" ? { window: c.window } : {}),
                        ...(typeof c.url === "string" ? { url: c.url } : {}),
                    };
                }
                const r = await planNext(deps, taskId, shot, typeof body.lastResult === "string" ? body.lastResult : undefined, perception);
                log("control next", { status: r.status, kind: r.step?.kind });
                return json(res, 200, r);
            }
            if (path === "/control/decision") {
                const cmd = parseControlCommand(typeof body.text === "string" ? body.text : "");
                if (!cmd)
                    return json(res, 422, { error: "not_a_command" });
                const r = cmd.kind === "cancel_task" ? await cancelTask(deps.pool, cmd.code) : await decideStep(deps.pool, cmd.code, cmd.kind === "ok_step");
                return json(res, 200, r);
            }
            if (path === "/control/step") {
                if (typeof body.stepId !== "string")
                    return json(res, 422, { error: "stepId_required" });
                const step = await getStep(deps.pool, body.stepId);
                return json(res, 200, { step });
            }
            if (path === "/control/result-image") {
                const code = Number(body.taskCode);
                if (!Number.isInteger(code))
                    return json(res, 422, { error: "taskCode_required" });
                const r = await getTaskResult(deps.pool, code);
                return json(res, 200, { imageB64: r?.imageB64 ?? null });
            }
            if (path === "/mac/chart") {
                const requested = typeof body.requested === "string" ? body.requested : "";
                const cands = Array.isArray(body.candidates) ? body.candidates : [];
                if (!requested || !cands.length)
                    return json(res, 200, { ok: false, message: "No workbook candidates were provided." });
                const ranked = rankCandidates(cands, requested);
                const top = ranked[0];
                const withBytes = top ? cands.find((c) => c.path === top.path) : undefined;
                if (!top || !withBytes?.b64)
                    return json(res, 200, { ok: false, message: "No readable spreadsheet candidate matched." });
                const result = analyzeWorkbookToChart({ path: top.path, name: top.name, size: top.size, mtimeMs: top.mtimeMs }, Buffer.from(withBytes.b64, "base64"), "Altarum pricing case");
                log("mac chart", { ok: result.ok, stages: result.stages.map((st) => `${st.stage}:${st.ok ? "ok" : "fail"}`).join(",") });
                return json(res, 200, { ok: result.ok, message: result.message, svgB64: result.svg ? Buffer.from(result.svg, "utf8").toString("base64") : null,
                    chosen: result.chosen ? { name: result.chosen.name } : null, pick: result.pick ?? null, stages: result.stages });
            }
            if (path === "/interaction/claim") {
                if (typeof body.guid !== "string")
                    return json(res, 422, { error: "guid_required" });
                const r = await claimInbound(deps.pool, body.guid, typeof body.handle === "string" ? body.handle : null);
                return json(res, 200, r);
            }
            if (path === "/interaction/finish") {
                if (typeof body.guid === "string")
                    await finishInbound(deps.pool, body.guid, body.ok !== false, typeof body.result === "string" ? body.result : undefined);
                return json(res, 200, { ok: true });
            }
            // ---- Mac runtime (ADR-066): heartbeat, claim/lease/progress, status ----
            if (path === "/mac/heartbeat") {
                await recordHeartbeat(deps.pool, {
                    reconnects: typeof body.reconnects === "number" ? body.reconnects : undefined,
                    helperVersion: typeof body.version === "string" ? body.version : undefined,
                    capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : undefined,
                    frontmostApp: typeof body.frontmostApp === "string" ? body.frontmostApp : null,
                    frontmostWindow: typeof body.frontmostWindow === "string" ? body.frontmostWindow : null,
                    currentTaskId: typeof body.currentTaskId === "string" ? body.currentTaskId : null,
                    startedAt: typeof body.startedAt === "string" ? body.startedAt : null,
                });
                if (body.context && typeof body.context === "object")
                    await saveContext(deps.pool, body.context).catch(() => { });
                const swept = await sweepStaleTasks(deps.pool).catch(() => ({ abandoned: 0, stalled: 0 }));
                return json(res, 200, { ok: true, swept });
            }
            if (path === "/control/claim") {
                if (typeof body.taskId !== "string")
                    return json(res, 400, { error: "taskId required" });
                const ok = await claimTask(deps.pool, body.taskId, typeof body.workerId === "string" ? body.workerId : "mac-helper");
                return json(res, 200, { claimed: ok });
            }
            if (path === "/control/progress") {
                if (typeof body.taskId !== "string")
                    return json(res, 400, { error: "taskId required" });
                await taskProgress(deps.pool, body.taskId, typeof body.note === "string" ? body.note : undefined);
                const ixq = await deps.pool.query(`SELECT interaction_id FROM control_task WHERE id = $1`, [body.taskId]);
                if (ixq.rows[0]?.interaction_id)
                    await setInteractionState(deps.pool, ixq.rows[0].interaction_id, "executing", typeof body.note === "string" ? body.note : undefined).catch(() => { });
                return json(res, 200, { ok: true });
            }
            if (path === "/control/result") {
                // Read a task's result by code (used by the doctor's round-trip probe and soak test).
                const code = Number(body.taskCode);
                if (!Number.isFinite(code))
                    return json(res, 400, { error: "taskCode required" });
                const r = await getTaskResult(deps.pool, code);
                if (!r)
                    return json(res, 404, { error: "no such task" });
                return json(res, 200, { status: r.status, summary: r.summary, hasImage: Boolean(r.imageB64) });
            }
            if (path === "/mac/status") {
                return json(res, 200, await macStatus(deps.pool));
            }
            if (path === "/artifact/register") {
                if (typeof body.storageRef !== "string" || typeof body.kind !== "string")
                    return json(res, 422, { error: "kind_and_storageRef_required" });
                const str = (v) => typeof v === "string" ? v : undefined;
                const a = await registerArtifact(deps.pool, { kind: body.kind, storageRef: body.storageRef,
                    mime: str(body.mime), summary: str(body.summary), origin: str(body.origin), conversation: str(body.conversation),
                    taskCode: typeof body.taskCode === "number" ? body.taskCode : undefined });
                return json(res, 200, { artifact: a });
            }
            if (path === "/artifact/recent") {
                const opts = {};
                if (typeof body.conversation === "string")
                    opts.conversation = body.conversation;
                if (typeof body.kind === "string")
                    opts.kind = body.kind;
                const a = await resolveRecentArtifact(deps.pool, opts);
                return json(res, 200, { artifact: a });
            }
            if (path === "/artifact/sent") {
                if (typeof body.id === "string")
                    await markArtifactSent(deps.pool, body.id);
                return json(res, 200, { ok: true });
            }
            if (path === "/mac/chart-done") {
                // WO1-G: a stale worker (lease reclaimed by another) cannot complete or fail the task.
                if (typeof body.taskId === "string" && !(await workerMayComplete(deps.pool, body.taskId, typeof body.workerId === "string" ? body.workerId : null)))
                    return json(res, 409, { error: "not_lease_holder" });
                if (typeof body.taskId === "string" && body.done === true && typeof body.imageB64 !== "string") {
                    // Non-image completion (e.g. mac_ping round-trip).
                    await deps.pool.query(`UPDATE control_task SET status = 'done', result_summary = $2, updated_at = now() WHERE id = $1 AND status = 'active'`, [body.taskId, String(body.summary ?? "done").slice(0, 1000)]);
                    await recordSuccess(deps.pool, body.taskId);
                    await completeForTask(deps.pool, body.taskId, { ok: true, summary: String(body.summary ?? "done") }).catch(() => { });
                    return json(res, 200, { ok: true });
                }
                if (typeof body.taskId === "string" && body.failed === true) {
                    // Terminal failure with a concrete reason (ADR-066): a task must never remain 'active' after the
                    // worker has given up on it.
                    await deps.pool.query(`UPDATE control_task SET status = 'failed', result_summary = $2, updated_at = now() WHERE id = $1 AND status = 'active'`, [body.taskId, String(body.summary ?? "failed on the Mac").slice(0, 1000)]);
                    await completeForTask(deps.pool, body.taskId, { ok: false, summary: String(body.summary ?? "failed on the Mac") }).catch(() => { });
                    return json(res, 200, { ok: true, failed: true });
                }
                if (typeof body.taskId === "string" && typeof body.imageB64 === "string") {
                    await setResultImage(deps.pool, body.taskId, body.imageB64);
                    await deps.pool.query(`UPDATE control_task SET status = 'done', result_summary = $2, updated_at = now() WHERE id = $1`, [body.taskId, String(body.summary ?? "chart ready").slice(0, 1000)]);
                    await recordSuccess(deps.pool, body.taskId);
                    await completeForTask(deps.pool, body.taskId, { ok: true, summary: String(body.summary ?? "chart ready"), imageB64: body.imageB64 }).catch(() => { });
                }
                return json(res, 200, { ok: true });
            }
            if (path === "/control/ran") {
                if (typeof body.stepId !== "string")
                    return json(res, 422, { error: "stepId_required" });
                await recordRun(deps.pool, body.stepId, body.ok === true, typeof body.result === "string" ? body.result : "");
                return json(res, 200, { ok: true });
            }
            return json(res, 404, { error: "not_found" });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message.slice(0, 200) : "error";
            log("control route bad_request", { path, reason });
            return json(res, 400, { error: "bad_request", reason });
        }
    };
}
//# sourceMappingURL=control-routes.js.map