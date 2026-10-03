/**
 * J5 helper API (ADR-044). Only the Mac iMessage helper calls these, with its own bearer secret
 * (CONCIERGE_HELPER_TOKEN). It is a separate credential from Claude's MCP tokens and from the
 * approval-page session, and it is refused on every other path.
 *
 *   POST /concierge/sync      contacts + new messages; returns drafts to show Julian
 *   POST /concierge/decision  Julian's "ok/no/edit <code>" from his own Messages thread
 *   POST /concierge/sent      the helper reports whether the approved reply went out
 *   POST /concierge/context   passages from Julian's files that the helper found (ADR-046); returns a draft
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { decide, draftForThread, ingest, markSent, parseCommand, processThread, type FileExcerpt, type FileRequest, type J5Deps, type NewDraft, type SyncContact, type SyncMessage } from "../pipelines/j5/concierge.js";

const MAX_BODY = 512_000;
const MAX_MESSAGES = 500;

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error("body too large"); chunks.push(c as Buffer); }
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  return v as Record<string, unknown>;
}

/** Constant-time comparison of the presented helper secret (hashed to equal lengths first). */
export function helperAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export function createConciergeHandler(deps: J5Deps, token: string | undefined, log: (msg: string, f?: Record<string, unknown>) => void) {
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    if (!token) return json(res, 404, { error: "not_found" });
    if (!helperAuthorized(req.headers.authorization, token)) return json(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    try {
      const body = await readJson(req);
      if (path === "/concierge/sync") {
        const contacts = Array.isArray(body.contacts) ? (body.contacts as SyncContact[]).slice(0, 50) : [];
        const messages = Array.isArray(body.messages) ? (body.messages as SyncMessage[]).slice(0, MAX_MESSAGES) : [];
        const touched = await ingest(deps.pool, contacts, messages);
        const filesEnabled = body.capabilities !== undefined && Array.isArray(body.capabilities) && body.capabilities.includes("files");
        const drafts: NewDraft[] = [];
        const fileRequests: FileRequest[] = [];
        for (const handle of touched) {
          const r = await processThread({ ...deps, filesEnabled }, handle).catch((err) => {
            log("concierge draft failed", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
            return {} as { draft?: NewDraft; fileRequest?: FileRequest };
          });
          if (r.draft) drafts.push(r.draft);
          if (r.fileRequest) fileRequests.push(r.fileRequest);
        }
        return json(res, 200, { drafts, fileRequests });
      }
      if (path === "/concierge/context") {
        if (typeof body.handle !== "string" || typeof body.trigger !== "string") return json(res, 422, { error: "handle_and_trigger_required" });
        const files = Array.isArray(body.files) ? (body.files as FileExcerpt[]).slice(0, 12) : [];
        const queries = Array.isArray(body.queries) ? (body.queries as unknown[]).filter((q): q is string => typeof q === "string").slice(0, 3) : [];
        const d = await draftForThread(deps, body.handle, files, body.trigger, queries).catch((err) => {
          log("concierge draft failed", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
          return null;
        });
        log("concierge drafted with files", { files: files.length, drafted: Boolean(d) });
        return json(res, 200, { drafts: d ? [d] : [] });
      }
      if (path === "/concierge/decision") {
        const cmd = parseCommand(typeof body.text === "string" ? body.text : "");
        if (!cmd) return json(res, 422, { error: "not_a_command" });
        return json(res, 200, await decide(deps.pool, cmd));
      }
      if (path === "/concierge/sent") {
        if (typeof body.id !== "string") return json(res, 422, { error: "id_required" });
        return json(res, 200, { updated: await markSent(deps.pool, body.id, body.ok === true) });
      }
      return json(res, 404, { error: "not_found" });
    } catch (err) {
      return json(res, 400, { error: "bad_request", reason: err instanceof Error ? err.message.slice(0, 120) : "error" });
    }
  };
}
