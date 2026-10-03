/**
 * J6 control API (ADR-050). Only the Mac helper calls these, with the same CONCIERGE_HELPER_TOKEN.
 *   POST /control/start     {request} -> {taskCode}            (Julian asked for a task)
 *   POST /control/next      {taskId?|taskCode?, screenshot?, lastResult?} -> next action or approval wait
 *   POST /control/decision  {text:"ok 7"} from Julian's Messages thread
 *   POST /control/ran       {stepId, ok, result}
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { cancelTask, createTask, decideStep, getStep, getTaskResult, parseControlCommand, planNext, recordRun, setResultImage, type ControlDeps } from "../pipelines/j6/control.js";
import { analyzeWorkbookToChart, rankCandidates, type Candidate } from "../mac/operator.js";

const MAX_BODY = 24 * 1024 * 1024; // screenshots + perception

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error("body too large"); chunks.push(c as Buffer); }
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  return v as Record<string, unknown>;
}
export function helperAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export function createControlHandler(deps: ControlDeps, token: string | undefined, log: (m: string, f?: Record<string, unknown>) => void) {
  async function taskIdFrom(body: Record<string, unknown>): Promise<string | null> {
    if (typeof body.taskId === "string") return body.taskId;
    if (Number.isInteger(body.taskCode)) {
      const r = await deps.pool.query<{ id: string }>(`SELECT id FROM control_task WHERE code = $1`, [body.taskCode]);
      return r.rows[0]?.id ?? null;
    }
    return null;
  }
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    if (!token) return json(res, 404, { error: "not_found" });
    if (!helperAuthorized(req.headers.authorization, token)) return json(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    try {
      const body = await readJson(req);
      if (path === "/control/start") {
        if (typeof body.request !== "string" || !body.request.trim()) return json(res, 422, { error: "request_required" });
        const origin = body.origin === "imessage" ? "imessage" : "chat";
        const t = await createTask(deps.pool, body.request, origin);
        return json(res, 200, { taskId: t.id, taskCode: t.code });
      }
      if (path === "/control/pending") {
        const r = await deps.pool.query(`SELECT id, code, request FROM control_task WHERE status = 'active'
          AND NOT EXISTS (SELECT 1 FROM control_step s WHERE s.task_id = control_task.id AND s.status IN ('proposed','running'))
          ORDER BY created_at LIMIT 5`);
        return json(res, 200, { tasks: r.rows });
      }
      if (path === "/control/next") {
        const taskId = await taskIdFrom(body);
        if (!taskId) return json(res, 404, { error: "task_not_found" });
        const shot = typeof body.screenshot === "string" ? body.screenshot : null;
        const perception: { pageText?: string; axTree?: string } = {};
        if (typeof body.pageText === "string") perception.pageText = body.pageText;
        if (typeof body.axTree === "string") perception.axTree = body.axTree;
        const r = await planNext(deps, taskId, shot, typeof body.lastResult === "string" ? body.lastResult : undefined, perception);
        log("control next", { status: r.status, kind: r.step?.kind });
        return json(res, 200, r);
      }
      if (path === "/control/decision") {
        const cmd = parseControlCommand(typeof body.text === "string" ? body.text : "");
        if (!cmd) return json(res, 422, { error: "not_a_command" });
        const r = cmd.kind === "cancel_task" ? await cancelTask(deps.pool, cmd.code) : await decideStep(deps.pool, cmd.code, cmd.kind === "ok_step");
        return json(res, 200, r);
      }
      if (path === "/control/step") {
        if (typeof body.stepId !== "string") return json(res, 422, { error: "stepId_required" });
        const step = await getStep(deps.pool, body.stepId);
        return json(res, 200, { step });
      }
      if (path === "/control/result-image") {
        const code = Number(body.taskCode);
        if (!Number.isInteger(code)) return json(res, 422, { error: "taskCode_required" });
        const r = await getTaskResult(deps.pool, code);
        return json(res, 200, { imageB64: r?.imageB64 ?? null });
      }
      if (path === "/mac/chart") {
        const requested = typeof body.requested === "string" ? body.requested : "";
        const cands = Array.isArray(body.candidates) ? body.candidates as Array<Candidate & { b64: string }> : [];
        if (!requested || !cands.length) return json(res, 200, { ok: false, message: "No workbook candidates were provided." });
        const ranked = rankCandidates(cands, requested);
        const top = ranked[0] as (Candidate & { b64?: string }) | undefined;
        const withBytes = top ? cands.find((c) => c.path === top.path) : undefined;
        if (!top || !withBytes?.b64) return json(res, 200, { ok: false, message: "No readable spreadsheet candidate matched." });
        const result = analyzeWorkbookToChart({ path: top.path, name: top.name, size: top.size, mtimeMs: top.mtimeMs }, Buffer.from(withBytes.b64, "base64"), "Altarum pricing case");
        log("mac chart", { ok: result.ok, stages: result.stages.map((st) => `${st.stage}:${st.ok ? "ok" : "fail"}`).join(",") });
        return json(res, 200, { ok: result.ok, message: result.message, svgB64: result.svg ? Buffer.from(result.svg, "utf8").toString("base64") : null,
          chosen: result.chosen ? { name: result.chosen.name } : null, pick: result.pick ?? null, stages: result.stages });
      }
      if (path === "/mac/chart-done") {
        if (typeof body.taskId === "string" && typeof body.imageB64 === "string") {
          await setResultImage(deps.pool, body.taskId, body.imageB64);
          await deps.pool.query(`UPDATE control_task SET status = 'done', result_summary = $2, updated_at = now() WHERE id = $1`, [body.taskId, String(body.summary ?? "chart ready").slice(0, 1000)]);
        }
        return json(res, 200, { ok: true });
      }
      if (path === "/control/ran") {
        if (typeof body.stepId !== "string") return json(res, 422, { error: "stepId_required" });
        await recordRun(deps.pool, body.stepId, body.ok === true, typeof body.result === "string" ? body.result : "");
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not_found" });
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : "error";
      log("control route bad_request", { path, reason });
      return json(res, 400, { error: "bad_request", reason });
    }
  };
}
