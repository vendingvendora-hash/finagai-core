/**
 * A scripted stand-in for the Anthropic Messages API, so the REAL Claude Code runtime (spawned by the
 * Agent SDK) can be driven deterministically in tests. Only the model is simulated.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Reply = { text: string } | { tool: string; input: Record<string, unknown> };
export interface MainRequest { body: any; system: string; apiKey: string; n: number }

export class MockClaude {
  requests: MainRequest[] = [];
  all: Array<{ path: string; apiKey: string }> = [];
  usage = { input_tokens: 50, output_tokens: 20 };
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = "";
  constructor(public script: (r: MainRequest) => Reply, private readonly marker = "FINAGAI AUTONOMOUS BUILDER") {}

  async start() { await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r)); this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; return this; }
  stop() { this.server.close(); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = ""; for await (const c of req) raw += c;
    const apiKey = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "");
    this.all.push({ path: req.url ?? "", apiKey });
    if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(req.method === "HEAD" ? 200 : 404); res.end("{}"); return; }
    const body = JSON.parse(raw);
    const system = Array.isArray(body.system) ? body.system.map((s: { text?: string }) => s.text ?? "").join("\n") : String(body.system ?? "");
    let reply: Reply = { text: "ok" };
    if (system.includes(this.marker) && Array.isArray(body.tools) && body.tools.length) {
      const r: MainRequest = { body, system, apiKey, n: this.requests.length };
      this.requests.push(r);
      reply = this.script(r);
    }
    this.respond(res, reply, Boolean(body.stream), body.model);
  }

  private respond(res: http.ServerResponse, reply: Reply, stream: boolean, model: string) {
    const isTool = "tool" in reply;
    const block = isTool ? { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2, 12)}`, name: reply.tool, input: reply.input } : { type: "text", text: reply.text };
    const msg = { id: `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [block], stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null, usage: this.usage };
    if (!stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(msg)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...this.usage, output_tokens: 0 } } });
    if (isTool) {
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { ...block, input: {} } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } });
    } else {
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (reply as { text: string }).text } });
    }
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  }
}

/** The tool_result blocks the runtime sent back in a main request (what the model "saw"). */
export function toolResults(r: MainRequest): Array<{ text: string; isError: boolean }> {
  // The runtime may append a mid-conversation system message after the tool results: use the last user turn.
  const last = [...r.body.messages].reverse().find((m: { role: string }) => m.role === "user");
  if (!last || !Array.isArray(last.content)) return [];
  return last.content.filter((b: { type: string }) => b.type === "tool_result").map((b: { content: unknown; is_error?: boolean }) => ({
    text: typeof b.content === "string" ? b.content : JSON.stringify(b.content), isError: Boolean(b.is_error) }));
}
