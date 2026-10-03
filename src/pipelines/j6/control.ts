/**
 * J6 Mac control agent (ADR-050).
 *
 * Julian asks Finagai to do something on his Mac. Finagai works one step at a time: it looks at a
 * screenshot, decides the next action, and classifies it READ (observe: screenshot, read text, list
 * apps) or WRITE (changes something: click, type, key, open app, run a command, move/delete a file).
 * READ steps run immediately. WRITE steps are queued and run only after Julian approves them with
 * "ok <code>" in his own Messages thread (the same channel as J5) — or he can approve a whole task.
 *
 * Core never touches the Mac itself: it plans and records; the Mac helper executes and sends back the
 * next screenshot. The model's output is a proposal, never a command Core runs blindly.
 */
import type pg from "pg";
import { appendEvent, withTransaction } from "../../db/index.js";
import type { MeteredModelClient } from "../../llm/metered.js";
import { BudgetBlockedError, type ContentBlock } from "../../llm/types.js";

export const J6_PROMPT_VERSION = "j6-control-v1";
export const MAX_STEPS_PER_TASK = 60;

/** Actions that only observe. Everything else is a WRITE and needs Julian's approval. */
export const READ_KINDS = new Set(["screenshot", "read_text", "list_apps", "list_files", "read_file", "wait", "done", "ask"]);
/** Actions the helper knows how to run. */
export const KNOWN_KINDS = new Set([...READ_KINDS,
  "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "hotkey",
  "open_app", "open_url", "open_path", "run", "move_file", "trash_file"]);

export interface Step {
  kind: string;
  params: Record<string, unknown>;
  risk: "read" | "write";
  summary: string;
  done?: boolean;
  question?: string;
}

export interface ControlDeps {
  pool: pg.Pool;
  model: Pick<MeteredModelClient, "complete">;
  modelId: string;
  autoApprove?: boolean;           // per Julian's choice for a task; still never covers irreversible kinds
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => Date;
}

/** Irreversible or high-blast-radius actions ALWAYS need an explicit per-step ok, even in auto mode. */
export const ALWAYS_CONFIRM = new Set(["run", "trash_file", "move_file"]);
const IRREVERSIBLE_HINT = /\b(send|pay|transfer|delete|remove|post|publish|submit|confirm purchase|place order|buy|wire)\b/i;

export function classifyRisk(kind: string): "read" | "write" {
  return READ_KINDS.has(kind) ? "read" : "write";
}

/** A write step is auto-runnable only if the task is in auto mode AND it is not in the always-confirm set
 *  AND its summary shows no irreversible intent. Everything else waits for Julian. */
export function needsApproval(step: Step, autoApprove: boolean): boolean {
  if (step.risk === "read") return false;
  if (!autoApprove) return true;
  if (ALWAYS_CONFIRM.has(step.kind)) return true;
  if (IRREVERSIBLE_HINT.test(step.summary)) return true;
  return false;
}

export function systemPrompt(timezone: string, today: string): string {
  return `You are Finagai operating Julian's Mac for him, as if you were him. He has asked you to do a task. You act one step at a time and you SEE the screen through screenshots.

Today is ${today} (${timezone}).

Each turn, look at the latest screenshot and output the single next action as JSON:
{"kind":"...","params":{...},"risk":"read|write","summary":"<one short line Julian would read>","done":false}

Action kinds:
- Observe (risk "read"): screenshot; read_text {}; list_apps {}; list_files {"dir":"~/..."}; read_file {"path":"~/..."}; wait {"seconds":N}; ask {"question":"..."} when you genuinely need Julian to decide; done {} when the task is finished.
- Act (risk "write"): click {"x":N,"y":N}; double_click; right_click; move {"x","y"}; drag {"from":[x,y],"to":[x,y]}; scroll {"x","y","amount":N,"dir":"up|down"}; type {"text":"..."}; key {"key":"return|tab|esc|..."}; hotkey {"keys":["cmd","c"]}; open_app {"name":"Safari"}; open_url {"url":"https://..."}; open_path {"path":"~/..."}; run {"cmd":"..."} (a shell command); move_file {"from","to"}; trash_file {"path"}.

Rules:
- Coordinates are in the screenshot's own pixels; take a fresh screenshot after anything that changes the screen.
- Set risk correctly: anything that changes files, apps, settings, or sends/posts/pays is "write".
- Never enter passwords, card numbers or 2FA codes: if a login, payment confirmation or legal agreement is required, stop with ask {"question":"..."} so Julian does that part.
- Prefer the smallest safe step. If unsure what Julian wants, ask instead of guessing.
- summary must let Julian approve safely without seeing the screen (e.g. 'Click "Send" on the email to Maria', not 'click at 812,440').
- When the task is complete, output done with a summary of what you accomplished.

Output ONLY the JSON object.`;
}

export function parseStep(text: string): Step | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const kind = String(raw.kind ?? "");
  if (!KNOWN_KINDS.has(kind)) return null;
  const summary = String(raw.summary ?? "").trim().slice(0, 500) || kind;
  const params = (raw.params && typeof raw.params === "object") ? raw.params as Record<string, unknown> : {};
  // Trust the declared risk only if it is at least as strict as our own classification.
  const risk = classifyRisk(kind) === "write" || raw.risk === "write" ? "write" : "read";
  const step: Step = { kind, params, risk, summary, done: raw.done === true || kind === "done" };
  if (kind === "ask") step.question = String(raw.question ?? raw.summary ?? "").slice(0, 500);
  return step;
}

export interface TaskView { id: string; code: number; status: string }

export async function createTask(pool: pg.Pool, request: string, origin: "chat" | "imessage" | "contact", requester?: string): Promise<TaskView> {
  return withTransaction(pool, async (tx) => {
    const r = await tx.query<{ id: string; code: string }>(
      `INSERT INTO control_task (request, origin, requester) VALUES ($1, $2, $3) RETURNING id, code`,
      [request.slice(0, 4000), origin, requester ?? null]);
    const row = r.rows[0]!;
    // The requester (a contact) can ASK; the task is still Julian's and only he approves steps.
    await appendEvent(tx, { actor: requester ? "j6" : "julian", action: "control_task_created", entityType: "control_task", entityId: row.id,
      after: { code: Number(row.code), request: request.slice(0, 200), requester: requester ?? null }, client: origin });
    return { id: row.id, code: Number(row.code), status: "active" };
  });
}

export interface NextResult {
  status: "run_read" | "await_approval" | "run_approved" | "ask" | "done" | "failed" | "cancelled";
  step?: { id: string; code: number; kind: string; params: Record<string, unknown>; summary: string };
  message?: string;
  /** When a contact requested the task, their label, so the helper can offer to reply to them. */
  requester?: string;
}

/**
 * Advance a task given the latest screenshot (base64 PNG) and the result of the previous step.
 * Returns the next thing for the helper to do: run a read step now, run a step Julian already approved,
 * or wait while a write step is queued for approval.
 */
export async function planNext(deps: ControlDeps, taskId: string, screenshotB64: string | null, lastResult?: string): Promise<NextResult> {
  const { pool } = deps;
  const task = (await pool.query<{ request: string; status: string; auto: boolean; requester: string | null }>(
    `SELECT request, status, false AS auto, requester FROM control_task WHERE id = $1`, [taskId])).rows[0];
  if (!task) return { status: "failed", message: "unknown task" };
  if (task.status === "cancelled") return { status: "cancelled" };

  const prior = (await pool.query<{ seq: number; kind: string; summary: string; status: string; result: string | null }>(
    `SELECT seq, kind, summary, status, result FROM control_step WHERE task_id = $1 ORDER BY seq`, [taskId])).rows;
  if (prior.length >= MAX_STEPS_PER_TASK) {
    await setTaskStatus(pool, taskId, "paused");
    return { status: "await_approval", message: "step limit reached; ask Julian to continue" };
  }

  const history = prior.map((s) => `${s.seq}. [${s.status}] ${s.summary}${s.result ? ` -> ${s.result.slice(0, 200)}` : ""}`).join("\n");
  const now = (deps.now ?? (() => new Date()))();
  const today = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const content: ContentBlock[] = [{ type: "text",
    text: `Task from Julian: ${task.request}\n\nSteps so far:\n${history || "(none yet)"}${lastResult ? `\n\nResult of the last step:\n${lastResult.slice(0, 2000)}` : ""}\n\nHere is the current screen. What is the single next action?` }];
  if (screenshotB64) content.push({ type: "image", mediaType: "image/png", dataBase64: screenshotB64 });

  let step: Step | null;
  try {
    const r = await deps.model.complete({
      pipeline: "j6", step: "plan", purpose: "concierge", model: deps.modelId, promptVersion: J6_PROMPT_VERSION,
      system: systemPrompt(now.toTimeString().slice(9), today), messages: [{ role: "user", content }], maxTokens: 700,
    });
    step = parseStep(r.text);
  } catch (err) {
    if (err instanceof BudgetBlockedError) { await setTaskStatus(pool, taskId, "paused"); return { status: "failed", message: "budget reached" }; }
    throw err;
  }
  if (!step) { await setTaskStatus(pool, taskId, "failed"); return { status: "failed", message: "could not plan the next step" }; }

  if (step.done) {
    await setTaskStatus(pool, taskId, "done");
    await appendEvent(pool, { actor: "j6", action: "control_task_done", entityType: "control_task", entityId: taskId, after: { summary: step.summary } });
    return task.requester ? { status: "done", message: step.summary, requester: task.requester } : { status: "done", message: step.summary };
  }
  if (step.kind === "ask") { await setTaskStatus(pool, taskId, "waiting_approval"); return { status: "ask", message: step.question ?? step.summary }; }

  const seq = prior.length + 1;
  const approval = needsApproval(step, task.auto);
  const row = await withTransaction(pool, async (tx) => {
    const ins = await tx.query<{ id: string; code: string }>(
      `INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status${approval ? "" : ", decided_at"})
       VALUES ($1, $2, $3, $4, $5, $6, $7${approval ? "" : ", now()"}) RETURNING id, code`,
      [taskId, seq, step!.kind, JSON.stringify(step!.params), step!.risk, step!.summary, approval ? "proposed" : (step!.risk === "write" ? "approved" : "approved")]);
    const r0 = ins.rows[0]!;
    await appendEvent(tx, { actor: "j6", action: "control_step_proposed", entityType: "control_step", entityId: r0.id,
      after: { code: Number(r0.code), kind: step!.kind, risk: step!.risk, summary: step!.summary, approval } });
    if (approval) await tx.query(`UPDATE control_task SET status = 'waiting_approval', updated_at = now() WHERE id = $1`, [taskId]);
    return r0;
  });
  const out = { id: row.id, code: Number(row.code), kind: step.kind, params: step.params, summary: step.summary };
  if (approval) return { status: "await_approval", step: out };
  return { status: step.risk === "read" ? "run_read" : "run_approved", step: out };
}

async function setTaskStatus(pool: pg.Pool, id: string, status: string): Promise<void> {
  await pool.query(`UPDATE control_task SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

/** Julian's decision on one queued step, or on a whole task, from his Messages thread. */
export type ControlCommand =
  | { kind: "ok_step" | "no_step"; code: number }
  | { kind: "cancel_task"; code: number };

export function parseControlCommand(text: string): ControlCommand | null {
  const m = /^\s*(ok|okay|si|sí|yes|no|stop|cancel)\s+#?(\d{1,9})\b/i.exec(text);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  const code = Number(m[2]);
  if (w === "stop" || w === "cancel") return { kind: "cancel_task", code };
  if (w === "no") return { kind: "no_step", code };
  return { kind: "ok_step", code };
}

export type DecisionResult =
  | { status: "approved"; stepId: string; taskId: string }
  | { status: "rejected"; taskId: string }
  | { status: "cancelled" | "not_found" | "already_handled" };

export async function decideStep(pool: pg.Pool, code: number, approve: boolean): Promise<DecisionResult> {
  return withTransaction(pool, async (tx) => {
    const s = (await tx.query<{ id: string; task_id: string; status: string }>(
      `SELECT id, task_id, status FROM control_step WHERE code = $1 FOR UPDATE`, [code])).rows[0];
    if (!s) return { status: "not_found" as const };
    if (s.status !== "proposed") return { status: "already_handled" as const };
    const next = approve ? "approved" : "rejected";
    await tx.query(`UPDATE control_step SET status = $2, decided_at = now() WHERE id = $1`, [s.id, next]);
    await tx.query(`UPDATE control_task SET status = $2, updated_at = now() WHERE id = $1`, [s.task_id, approve ? "active" : "paused"]);
    await appendEvent(tx, { actor: "julian", action: approve ? "control_step_approved" : "control_step_rejected",
      entityType: "control_step", entityId: s.id, client: "imessage_helper" });
    return approve ? { status: "approved" as const, stepId: s.id, taskId: s.task_id } : { status: "rejected" as const, taskId: s.task_id };
  });
}

export async function cancelTask(pool: pg.Pool, code: number): Promise<DecisionResult> {
  return withTransaction(pool, async (tx) => {
    const t = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM control_task WHERE code = $1 FOR UPDATE`, [code])).rows[0];
    if (!t) return { status: "not_found" as const };
    await tx.query(`UPDATE control_task SET status = 'cancelled', updated_at = now() WHERE id = $1`, [t.id]);
    await tx.query(`UPDATE control_step SET status = 'superseded' WHERE task_id = $1 AND status IN ('proposed','approved')`, [t.id]);
    await appendEvent(tx, { actor: "julian", action: "control_task_cancelled", entityType: "control_task", entityId: t.id, client: "imessage_helper" });
    return { status: "cancelled" as const };
  });
}

/** The helper reports what happened when it ran a step. */
export async function getStep(pool: pg.Pool, stepId: string): Promise<{ id: string; kind: string; params: Record<string, unknown>; summary: string } | null> {
  const r = await pool.query<{ id: string; kind: string; params: Record<string, unknown>; summary: string }>(
    `SELECT id, kind, params, summary FROM control_step WHERE id = $1 AND status = 'approved'`, [stepId]);
  return r.rows[0] ?? null;
}

export async function recordRun(pool: pg.Pool, stepId: string, ok: boolean, result: string): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await tx.query(`UPDATE control_step SET status = $2, result = $3, ran_at = now() WHERE id = $1`, [stepId, ok ? "done" : "failed", result.slice(0, 4000)]);
    await appendEvent(tx, { actor: "j6", action: ok ? "control_step_ran" : "control_step_failed", entityType: "control_step", entityId: stepId,
      after: { result: result.slice(0, 200) }, client: "mac_helper" });
  });
}
