import { routeHint } from "../../mac/router.js";
import { deriveContract, verifyCompletion, recoveryDecision, REJECTION_MARKER } from "../../mac/acceptance.js";
import { appendEvent, withTransaction } from "../../db/index.js";
import { BudgetBlockedError } from "../../llm/types.js";
import { skillsFor } from "./skills.js";
export const J6_PROMPT_VERSION = "j6-control-v3";
export const MAX_STEPS_PER_TASK = 80;
/** Actions that only observe. Everything else is a WRITE and needs Julian's approval. */
export const READ_KINDS = new Set(["screenshot", "read_text", "list_apps", "list_files", "read_file", "wait", "done", "ask", "observe"]);
/** Actions the helper knows how to run. */
export const KNOWN_KINDS = new Set([...READ_KINDS,
    "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "hotkey",
    "open_app", "open_url", "open_path", "run", "move_file", "trash_file",
    "activate_app", "menu_item", "ax_click", "ax_set_value"]); // WO4 accessibility-first (verified) actions
/** Irreversible or high-blast-radius actions ALWAYS need an explicit per-step ok, even in auto mode. */
export const ALWAYS_CONFIRM = new Set(["run", "trash_file", "move_file"]);
const IRREVERSIBLE_HINT = /\b(send|enviar|mandar|pay|pagar|transfer|transferir|delete|borrar|eliminar|remove|post|publish|publicar|submit|enviar formulario|confirm purchase|place order|buy|comprar|wire|reply all)\b/i;
/**
 * A shell command that provably cannot change anything: an allow-listed read-only binary, no shell
 * metacharacters (so no redirects, pipes, chaining, substitution, globbing into writes), no destructive flags.
 * Such a `run` is a READ (live task #104: `cat ~/.finagai/phase1-live.out` should never need Julian's ok).
 */
const READONLY_BINARIES = /^(cat|ls|head|tail|wc|stat|file|grep|egrep|mdfind|mdls|pwd|date|sw_vers|shasum|md5|du|df|uptime|whoami|which|plutil -p|defaults read)(\s|$)/;
export function isReadOnlyCommand(cmd) {
    if (typeof cmd !== "string")
        return false;
    const c = cmd.trim();
    if (!c || c.length > 400 || /[;&|<>`$(){}\n\\]/.test(c))
        return false;
    if (/\s-(exec|delete|ok|fprint|i\b)|\s--in-place|\s-w\b/.test(c))
        return false;
    if (!READONLY_BINARIES.test(c))
        return false;
    // Protected paths stay behind Julian's ok even for reads — mirrors the helper's EXCLUDED_PATH (the helper
    // config with its bearer token lives in ~/.finagai; live #104 was correctly refused there).
    const tokens = c.split(/\s+/).slice(1);
    for (const t of tokens) {
        if (/(^|\/)\.[^/\s]/.test(t))
            return false; // any hidden component (~/.finagai, .ssh, .., .env)
        if (t.startsWith("/") && !t.startsWith("/Users/"))
            return false; // system paths (/etc, /private, /var)
        if (/\/Library\/(?!CloudStorage\/|Mobile Documents\/)|^~?\/?Library\b/.test(t))
            return false;
        if (/keychain|password|passwd|\.ssh|\.gnupg|finagai-core|node_modules|\.(key|pem|p12|kdbx|keychain-db|sqlite|db)$/i.test(t))
            return false;
    }
    return true;
}
export function classifyRisk(kind) {
    return READ_KINDS.has(kind) ? "read" : "write";
}
/** A write step is auto-runnable only if the task is in auto mode AND it is not in the always-confirm set
 *  AND its summary shows no irreversible intent. Everything else waits for Julian. */
export function needsApproval(step, autoApprove) {
    if (step.risk === "read")
        return false;
    if (!autoApprove)
        return true;
    if (ALWAYS_CONFIRM.has(step.kind))
        return true;
    if (IRREVERSIBLE_HINT.test(step.summary))
        return true;
    return false;
}
export function systemPrompt(timezone, today, request) {
    return `You are Finagai operating Julian's Mac for him, as if you were him. You pursue his goal autonomously and only stop for things that genuinely need him. You SEE the screen through screenshots and you are also given the page's visible text and accessibility tree when available.

Today is ${today} (${timezone}).

THINK in a plan-act-reflect loop every turn:
1) REFLECT on the previous result: did the last step achieve what you expected? If the screen did not change as expected, the step failed — diagnose why and change approach (don't repeat it).
2) PLAN: in one line, the shortest path from here to the goal.
3) ACT: choose the single next action.

Keep every field short (reflection/plan/summary ≤ 300 characters). Read results (file lists, page text, file
contents) are attached to the final report automatically — NEVER copy them into "summary"; for done, summarize
the answer in one or two sentences.
Output ONLY this JSON object:
{"reflection":"<what the last result tells you / why it failed>","plan":"<one line to the goal>","kind":"...","params":{...},"risk":"read|write","summary":"<one line Julian could approve without seeing the screen>","expect":"<what the screen should show after this action>","done":false}

Action kinds:
- Observe (risk "read"): screenshot; read_text {}; list_apps {}; list_files {"dir":"~/..."}; read_file {"path":"~/..."}; wait {"seconds":N}; ask {"question":"..."} ONLY as a last resort; done {} when finished.
- CONTROL HIERARCHY (WO4) — prefer, in order: activate_app {"name"} · menu_item {"app","path":["File","New"]} · ax_click {"app","title","role?"} (click a control by its accessibility title; roles AXButton/AXCheckBox/AXMenuButton/AXRadioButton) · ax_set_value {"app","title?","role?","value"} (text fields, read back) · observe {} (cheap UI-state read) — and only when no control has a usable title, fall back to click {"x","y"}. Every AX action returns "verified:" / "unverified:" / "error:" with the before→after app/window/focus delta: treat "unverified" as NOT done — observe or screenshot and check the expected outcome before continuing.
- Act (risk "write"): click {"x":N,"y":N}; double_click; right_click; move {"x","y"}; drag {"from":[x,y],"to":[x,y]}; scroll {"x","y","amount":N,"dir":"up|down"}; type {"text":"..."}; key {"key":"return|tab|esc|..."}; hotkey {"keys":["cmd","c"]}; open_app {"name":"Safari"}; open_url {"url":"https://..."}; open_path {"path":"~/..."}; run {"cmd":"..."}; move_file {"from","to"}; trash_file {"path"}.

Operating principles:
- Be autonomous. Exhaust the obvious routes yourself before asking Julian. Prefer typing URLs and using on-page search over clicking through UIs.
- Julian is signed in to his Google accounts in Chrome; Drive/Gmail number accounts as /u/0/, /u/1/, /u/2/. If one account doesn't have something, TRY THE OTHER ACCOUNTS before giving up.
- Verify, don't assume: use "expect" to say what should happen, and check it next turn via the screenshot/text.
- Never repeat an action that didn't change the screen — switch approach.
- Passwords, payment confirmations and legal "I agree" are the only things you must hand to Julian with ask{}. You never type passwords.
- As you go, when a read step reveals the answer (a value, a file's contents, an event), state it plainly in the step result so it can be used later.
- When the task is done, output done with a summary that CONTAINS the answer (the numbers, the file name, what you found), not just "done".${skillsFor(request)}`;
}
export function parseStep(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    let raw;
    try {
        raw = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
    const kind = String(raw.kind ?? "");
    if (!KNOWN_KINDS.has(kind))
        return null;
    const summary = String(raw.summary ?? "").trim().slice(0, 500) || kind;
    const params = (raw.params && typeof raw.params === "object") ? raw.params : {};
    // Trust the declared risk only if it is at least as strict as our own classification.
    const risk = classifyRisk(kind) === "write" || raw.risk === "write" ? "write" : "read";
    const effectiveRisk = kind === "run" && isReadOnlyCommand(params.cmd) ? "read" : risk;
    const step = { kind, params, risk: effectiveRisk, summary, done: raw.done === true || kind === "done" };
    if (kind === "ask")
        step.question = String(raw.question ?? raw.summary ?? "").slice(0, 500);
    if (typeof raw.reflection === "string")
        step.reflection = raw.reflection.slice(0, 600);
    if (typeof raw.expect === "string")
        step.expect = raw.expect.slice(0, 300);
    return step;
}
export async function createTask(pool, request, origin, requester) {
    return withTransaction(pool, async (tx) => {
        const r = await tx.query(`INSERT INTO control_task (request, origin, requester, acceptance) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, code`, [request.slice(0, 4000), origin, requester ?? null, JSON.stringify(deriveContract(request))]);
        const row = r.rows[0];
        // The requester (a contact) can ASK; the task is still Julian's and only he approves steps.
        await appendEvent(tx, { actor: requester ? "j6" : "julian", action: "control_task_created", entityType: "control_task", entityId: row.id,
            after: { code: Number(row.code), request: request.slice(0, 200), requester: requester ?? null }, client: origin });
        return { id: row.id, code: Number(row.code), status: "active" };
    });
}
/**
 * Advance a task given the latest screenshot (base64 PNG) and the result of the previous step.
 * Returns the next thing for the helper to do: run a read step now, run a step Julian already approved,
 * or wait while a write step is queued for approval.
 */
export async function planNext(deps, taskId, screenshotB64, lastResult, perception) {
    // The latest screenshot doubles as the artifact image if the agent declares done this turn.
    const { pool } = deps;
    const task = (await pool.query(`SELECT request, status, true AS auto, requester FROM control_task WHERE id = $1`, [taskId])).rows[0];
    if (!task)
        return { status: "failed", message: "unknown task" };
    if (task.status === "cancelled")
        return { status: "cancelled" };
    const prior = (await pool.query(`SELECT seq, kind, summary, status, result FROM control_step WHERE task_id = $1 ORDER BY seq`, [taskId])).rows;
    if (prior.length >= MAX_STEPS_PER_TASK) {
        await setTaskStatus(pool, taskId, "paused");
        return { status: "await_approval", message: "step limit reached; ask Julian to continue" };
    }
    const history = prior.map((s) => `${s.seq}. [${s.status}] ${s.summary}${s.result ? ` -> ${s.result.slice(0, 200)}` : ""}`).join("\n");
    const now = (deps.now ?? (() => new Date()))();
    const today = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const ctx = perception?.context;
    const ctxLine = ctx && (ctx.app || ctx.window || ctx.url)
        ? `Current Mac context — frontmost app: ${ctx.app ?? "?"}${ctx.window ? `; active window: “${ctx.window}”` : ""}${ctx.url ? `; browser URL: ${ctx.url}` : ""}. Use this to resolve "this"/"the open document"/"the spreadsheet I have open" when Julian is vague.`
        : "";
    // WO4/WO8: state the preferred execution path from the health matrix so the planner never starts from a click.
    let routeLine = "";
    try {
        const rt = await deps.pool.query(`SELECT (SELECT capabilities FROM mac_runtime WHERE id = 'primary') AS capabilities, request FROM control_task WHERE id = $1`, [taskId]);
        const row = rt.rows[0];
        if (row)
            routeLine = routeHint(row.request, row.capabilities);
    }
    catch { /* routing is advisory */ }
    const percept = [
        routeLine,
        ctxLine,
        perception?.pageText ? `Visible page text (truncated):\n${perception.pageText.slice(0, 4000)}` : "",
        perception?.axTree ? `Accessibility tree / clickable elements (truncated):\n${perception.axTree.slice(0, 4000)}` : "",
    ].filter(Boolean).join("\n\n");
    const content = [{ type: "text",
            text: `Task from Julian: ${task.request}\n\nSteps so far:\n${history || "(none yet)"}${lastResult ? `\n\nResult of the last step:\n${lastResult.slice(0, 2000)}` : ""}${percept ? `\n\n${percept}` : ""}\n\nHere is the current screen. Reflect, plan, then give the single next action.` }];
    if (screenshotB64)
        content.push({ type: "image", mediaType: "image/png", dataBase64: screenshotB64 });
    const basePlan = {
        pipeline: "j6", step: "plan", purpose: "concierge", promptVersion: J6_PROMPT_VERSION,
        system: systemPrompt(now.toTimeString().slice(9), today, task.request), messages: [{ role: "user", content }], maxTokens: 3000,
    };
    await pool.query(`UPDATE control_task SET model_calls = model_calls + 1 WHERE id = $1`, [taskId]).catch(() => { });
    let step;
    try {
        let r;
        try {
            r = await deps.model.complete({ ...basePlan, model: deps.plannerModel ?? deps.modelId,
                ...(deps.thinkingTokens && deps.thinkingTokens > 0 ? { thinkingTokens: deps.thinkingTokens } : {}) });
        }
        catch (err1) {
            if (err1 instanceof BudgetBlockedError)
                throw err1;
            // The planner model or extended-thinking params may be rejected by the API — fall back to the
            // plain runtime model with no thinking, so a task is never dead-ended by a bad planner config.
            deps.log?.("planner call failed; falling back to runtime model", { error: String(err1?.message ?? err1).slice(0, 160) });
            r = await deps.model.complete({ ...basePlan, model: deps.modelId });
        }
        step = parseStep(r.text);
        if (!step) {
            // An unparseable reply (often truncated JSON) must not silently fail the task: one compact repair attempt.
            deps.log?.("planner reply unparseable; repairing", { tail: String(r.text).slice(-160) });
            const repair = await deps.model.complete({ ...basePlan, model: deps.modelId, maxTokens: 800,
                messages: [{ role: "user", content }, { role: "assistant", content: String(r.text).slice(0, 4000) },
                    { role: "user", content: "Your reply was not ONE valid JSON step (it may have been cut off). Reply again with ONE short JSON object only, every field ≤ 300 characters; do not list read results." }] });
            await pool.query(`UPDATE control_task SET model_calls = model_calls + 1 WHERE id = $1`, [taskId]).catch(() => { });
            step = parseStep(repair.text);
            if (!step) {
                await pool.query(`UPDATE control_task SET status = 'failed', failure_class = 'model_parse', terminal_reason = 'model_parse',
          result_summary = 'The planner returned an unreadable reply twice; nothing was done after the last completed step.', updated_at = now() WHERE id = $1`, [taskId]);
                const { completeForTask } = await import("../../concierge/interactions.js");
                await completeForTask(pool, taskId, { ok: false, summary: "Stopped: the planner's reply could not be read (twice)." }).catch(() => { });
                return { status: "failed", message: "planner reply unreadable twice" };
            }
        }
    }
    catch (err) {
        if (err instanceof BudgetBlockedError) {
            await setTaskStatus(pool, taskId, "paused");
            return { status: "failed", message: "budget reached" };
        }
        deps.log?.("planner failed", { error: String(err?.message ?? err).slice(0, 160) });
        await pool.query(`UPDATE control_task SET status = 'failed', failure_class = 'model_error', terminal_reason = 'model_error',
      result_summary = $2, updated_at = now() WHERE id = $1`, [taskId, `The planner model call failed: ${String(err?.message ?? err).slice(0, 200)}`]);
        return { status: "failed", message: "couldn't plan the next step" };
    }
    if (!step) {
        await pool.query(`UPDATE control_task SET status = 'failed', failure_class = 'model_parse', terminal_reason = 'model_parse', result_summary = 'Could not plan the next step.', updated_at = now() WHERE id = $1`, [taskId]);
        return { status: "failed", message: "could not plan the next step" };
    }
    if (step.done) {
        // Phase 1A: the planner's `done` is a CLAIM. An independent verifier must pass first.
        const taskRow = await pool.query(`UPDATE control_task SET completion_claims = completion_claims + 1 WHERE id = $1 RETURNING acceptance, verification_rejections, last_claim_summary, created_at`, [taskId]);
        const contract = taskRow.rows[0]?.acceptance ?? deriveContract(task.request);
        const trace = prior.map((x) => ({ kind: x.kind, summary: x.summary, result: x.result ?? null }));
        const verdict = await verifyCompletion({ model: deps.model, graderModel: deps.graderModel ?? deps.plannerModel ?? deps.modelId }, contract, trace, step.summary, screenshotB64);
        await pool.query(`UPDATE control_task SET verification = $2::jsonb, verify_attempts = verify_attempts + 1, last_claim_summary = $3, updated_at = now() WHERE id = $1`, [taskId, JSON.stringify({ ...verdict, at: new Date().toISOString() }), step.summary.slice(0, 500)]);
        if (!verdict.pass) {
            // A rejected claim = false_completion (never shown to Julian as success). Then BOUNDED RECOVERY, not failure.
            const rejections = Number(taskRow.rows[0]?.verification_rejections ?? 0) + 1;
            const decision = recoveryDecision({ rejectionsIncludingThis: rejections, trace, claimSummary: step.summary,
                lastClaimSummary: taskRow.rows[0]?.last_claim_summary ?? null, taskStartedAtMs: new Date(taskRow.rows[0]?.created_at ?? Date.now()).getTime(), nowMs: Date.now() });
            await appendEvent(pool, { actor: "j6", action: "false_completion", entityType: "control_task", entityId: taskId,
                after: { reason: verdict.reason, strategy: verdict.strategy, rejection: rejections, decision: decision.action, terminalReason: decision.action === "terminal" ? decision.terminalReason : null, strategyChanged: decision.strategyChanged } });
            await pool.query(`UPDATE control_task SET verification_rejections = $2, recovery_strategy_changed = recovery_strategy_changed OR $3 WHERE id = $1`, [taskId, rejections, decision.strategyChanged]);
            await pool.query(`UPDATE interaction SET false_completion = true, verification_attempts = verification_attempts + 1 WHERE $1 = ANY(task_ids)`, [taskId]).catch(() => { });
            if (decision.action === "terminal") {
                await pool.query(`UPDATE control_task SET status = 'failed', failure_class = 'false_completion', terminal_reason = $3, result_summary = $2, updated_at = now() WHERE id = $1`, [taskId, `Not completed — the result could not be verified (${decision.terminalReason}): ${verdict.reason}`.slice(0, 1000), decision.terminalReason]);
                const { completeForTask } = await import("../../concierge/interactions.js");
                await completeForTask(pool, taskId, { ok: false, summary: `Not completed — could not verify the result (${decision.terminalReason.replace(/_/g, " ")}): ${verdict.reason}` }).catch(() => { });
                return { status: "failed", message: `not verified: ${verdict.reason}` };
            }
            await pool.query(`UPDATE control_task SET recovery_attempts = recovery_attempts + 1 WHERE id = $1`, [taskId]);
            // Re-observe (persisted as a normal read step); its summary carries the reason the planner must address.
            step = { kind: "observe", params: {}, risk: "read", done: false,
                summary: `${REJECTION_MARKER} the claimed completion (${verdict.reason.slice(0, 160)}) — re-observe, diagnose why, and change approach if the last one did not work; claim done only when the expected outcome is observable` };
        }
        else {
            await pool.query(`UPDATE control_task SET verification = verification || '{"accepted":true}'::jsonb WHERE id = $1`, [taskId]).catch(() => { });
            // Gather what the read steps found so the chat can read the answer (ADR-056).
            const detail = prior.filter((x) => x.result && x.result.trim()).map((x) => `- ${x.summary}: ${x.result.slice(0, 1200)}`).join("\n").slice(0, 20000);
            const { completeForTask } = await import("../../concierge/interactions.js");
            await completeForTask(pool, taskId, { ok: true, summary: step.summary, imageB64: screenshotB64 && screenshotB64.length < 8_000_000 ? screenshotB64 : null }).catch(() => { });
            await pool.query(`UPDATE control_task SET status = 'done', terminal_reason = 'verified', result_summary = $2, result_detail = $3, result_image_b64 = COALESCE($4, result_image_b64), updated_at = now() WHERE id = $1`, [taskId, step.summary.slice(0, 1000), detail || null, screenshotB64 && screenshotB64.length < 8_000_000 ? screenshotB64 : null]);
            await appendEvent(pool, { actor: "j6", action: "control_task_done", entityType: "control_task", entityId: taskId, after: { summary: step.summary } });
            return task.requester ? { status: "done", message: step.summary, requester: task.requester } : { status: "done", message: step.summary };
        }
    }
    if (step.kind === "ask") {
        await setTaskStatus(pool, taskId, "waiting_approval");
        return { status: "ask", message: step.question ?? step.summary };
    }
    // Loop guard: the same action repeating means the agent can't tell it made progress.
    const recent = prior.slice(-4).map((x) => `${x.kind}|${x.summary}`.toLowerCase());
    const sig = `${step.kind}|${step.summary}`.toLowerCase();
    const repeats = recent.filter((r) => r === sig).length;
    if (repeats >= 2) {
        await setTaskStatus(pool, taskId, "waiting_approval");
        deps.log?.("control loop detected", { kind: step.kind });
        return { status: "ask", message: `I keep trying the same step ("${step.summary}") without it working. Tell me how to proceed, or stop ${""}.` };
    }
    const seq = prior.length + 1;
    const approval = needsApproval(step, task.auto);
    const row = await withTransaction(pool, async (tx) => {
        const ins = await tx.query(`INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status${approval ? "" : ", decided_at"})
       VALUES ($1, $2, $3, $4, $5, $6, $7${approval ? "" : ", now()"}) RETURNING id, code`, [taskId, seq, step.kind, JSON.stringify(step.params), step.risk, step.summary, approval ? "proposed" : (step.risk === "write" ? "approved" : "approved")]);
        const r0 = ins.rows[0];
        await appendEvent(tx, { actor: "j6", action: "control_step_proposed", entityType: "control_step", entityId: r0.id,
            after: { code: Number(r0.code), kind: step.kind, risk: step.risk, summary: step.summary, approval, reflection: step.reflection ?? null, expect: step.expect ?? null } });
        if (approval)
            await tx.query(`UPDATE control_task SET status = 'waiting_approval', updated_at = now() WHERE id = $1`, [taskId]);
        return r0;
    });
    const out = { id: row.id, code: Number(row.code), kind: step.kind, params: step.params, summary: step.summary };
    if (approval)
        return { status: "await_approval", step: out };
    return { status: step.risk === "read" ? "run_read" : "run_approved", step: out };
}
async function setTaskStatus(pool, id, status) {
    await pool.query(`UPDATE control_task SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}
export function parseControlCommand(text) {
    const m = /^\s*(ok|okay|si|sí|yes|no|stop|cancel)\s+#?(\d{1,9})\b/i.exec(text);
    if (!m)
        return null;
    const w = m[1].toLowerCase();
    const code = Number(m[2]);
    if (w === "stop" || w === "cancel")
        return { kind: "cancel_task", code };
    if (w === "no")
        return { kind: "no_step", code };
    return { kind: "ok_step", code };
}
export async function decideStep(pool, code, approve) {
    return withTransaction(pool, async (tx) => {
        const s = (await tx.query(`SELECT id, task_id, status FROM control_step WHERE code = $1 FOR UPDATE`, [code])).rows[0];
        if (!s)
            return { status: "not_found" };
        if (s.status !== "proposed")
            return { status: "already_handled" };
        const next = approve ? "approved" : "rejected";
        await tx.query(`UPDATE control_step SET status = $2, decided_at = now() WHERE id = $1`, [s.id, next]);
        await tx.query(`UPDATE control_task SET status = $2, updated_at = now() WHERE id = $1`, [s.task_id, approve ? "active" : "paused"]);
        await appendEvent(tx, { actor: "julian", action: approve ? "control_step_approved" : "control_step_rejected",
            entityType: "control_step", entityId: s.id, client: "imessage_helper" });
        return approve ? { status: "approved", stepId: s.id, taskId: s.task_id } : { status: "rejected", taskId: s.task_id };
    });
}
export async function cancelTask(pool, code) {
    return withTransaction(pool, async (tx) => {
        const t = (await tx.query(`SELECT id, status FROM control_task WHERE code = $1 FOR UPDATE`, [code])).rows[0];
        if (!t)
            return { status: "not_found" };
        await tx.query(`UPDATE control_task SET status = 'cancelled', updated_at = now() WHERE id = $1`, [t.id]);
        await tx.query(`UPDATE control_step SET status = 'superseded' WHERE task_id = $1 AND status IN ('proposed','approved')`, [t.id]);
        await appendEvent(tx, { actor: "julian", action: "control_task_cancelled", entityType: "control_task", entityId: t.id, client: "imessage_helper" });
        return { status: "cancelled" };
    });
}
/** The helper reports what happened when it ran a step. */
export async function getStep(pool, stepId) {
    const r = await pool.query(`SELECT id, kind, params, summary FROM control_step WHERE id = $1 AND status = 'approved'`, [stepId]);
    return r.rows[0] ?? null;
}
/** Read a task's current state and result, for the chat that started it (ADR-056). */
export async function getTaskResult(pool, code) {
    const r = await pool.query(`SELECT code, status, request, result_summary, result_detail, result_image_b64, updated_at FROM control_task WHERE code = $1`, [code]);
    const t = r.rows[0];
    if (!t)
        return null;
    return { code: Number(t.code), status: t.status, request: t.request, summary: t.result_summary, detail: t.result_detail, imageB64: t.result_image_b64, updatedAt: t.updated_at.toISOString() };
}
/** The latest task, so the chat can check "the task I just started" without needing its code. */
export async function latestTask(pool) {
    const r = await pool.query(`SELECT code FROM control_task ORDER BY created_at DESC LIMIT 1`);
    return r.rows[0] ? getTaskResult(pool, Number(r.rows[0].code)) : null;
}
/** Save the final artifact image for a task (ADR-058), so the chat and iMessage can show it. */
export async function setResultImage(pool, taskId, imageB64) {
    await pool.query(`UPDATE control_task SET result_image_b64 = $2, updated_at = now() WHERE id = $1`, [taskId, imageB64.slice(0, 8_000_000)]);
}
export async function recordRun(pool, stepId, ok, result) {
    await withTransaction(pool, async (tx) => {
        await tx.query(`UPDATE control_step SET status = $2, result = $3, ran_at = now() WHERE id = $1`, [stepId, ok ? "done" : "failed", result.slice(0, 4000)]);
        await appendEvent(tx, { actor: "j6", action: ok ? "control_step_ran" : "control_step_failed", entityType: "control_step", entityId: stepId,
            after: { result: result.slice(0, 200) }, client: "mac_helper" });
    });
}
//# sourceMappingURL=control.js.map