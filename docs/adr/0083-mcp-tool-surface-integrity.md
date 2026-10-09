# ADR-083 — MCP tool-surface integrity: a deployed tool must be reachable, measurably

Status: Decided (builder, under Julian's 2026-10-09 mandate)
Date: 2026-10-09

## Context
The Phase 4 live test failed. A brand-new chat could not find `sync_career`, and `bootstrap_area` (Hotfix 14) told it to call that tool. The server registered the tool, and its code was live: the redirect itself proves Hotfix 14 was running, and `sync_career` is registered by the same function. The tool was still missing from the model's tool list.

Root cause: claude.ai caches each connector's `tools/list` per connector URL, outside Finagai.
- Anthropic staff in anthropics/claude-ai-mcp#45 put the cache at about 1 hour; reports there describe 15–24 hours.
- None of these invalidate it: `notifications/tools/list_changed`, `serverInfo.version`, `ttlMs: 0`, disconnect/reconnect.
- Phase 4 tools were deployed about 16:45 and tested at 16:58 and 17:00, inside that window.
- Tools added hours earlier (Phase 3, ADR-080) were visible.

So any newly deployed Finagai tool, in any vertical, could be invisible for an unbounded time while the server and its own instructions treat it as available. That is a class defect, not a Career one.

## Decision
1. **The registry is the single source of truth.** `buildMcpServer` records every `registerTool` call in a catalog and rejects duplicate names. A manifest (registration order, plus a digest over names, descriptions and input schemas) is computed from that catalog.
2. **Two stable meta-tools are registered first:**
   - `list_tools` returns the live catalog with schemas, optionally filtered by a query.
   - `call_tool` runs any live tool by name. It uses the same zod validation, handler, tier filter and audit as a direct call. It refuses unknown tools and the meta-tools themselves, and records attempts on unknown tools.

   These two never change. Once a client's cache holds them, every tool deployed later is reachable immediately.
3. **References to other tools always carry the fallback.** Tool outputs that name another tool go through `toolRef()`, which adds the `call_tool` route. The server's `instructions` tell the model that its list may be stale and that it should use `list_tools`/`call_tool`.
4. **Observability:**
   - `/health` publishes `tools {count, digest}`.
   - Core records each client `initialize` (client info, protocol version), each `tools/list` served (digest, count), and each `tools/call` of a name that isn't registered.
   - The operator channel (`finagai-job: mcp-manifest`) returns the live manifest and that traffic.
5. **Release gates:**
   - `docs/mcp-tool-manifest.json` is the committed production surface. An integration test fails when the code and the file disagree.
   - Another test fails when any description or instruction names a tool that isn't registered.
   - The release script compares `/health` against the committed digest after each deploy.

## Consequences
- **New tools ship without waiting on client caches**, as long as the client has cached `list_tools`/`call_tool` once (one cache cycle after this deploy).
- **Limit:** client-side caching can't be fixed from the server. A new chat may still show a stale list for a while; the meta-tools make that harmless.
- **Rejected alternative:** changing the connector URL to force a refresh. It would require re-authorizing the connector and an OAuth resource change.

## Evidence
- Integration tests:
  - `list_tools` returns exactly the registered set.
  - `call_tool` gives the same answer as a direct call, applies the same validation errors, and refuses unknown and meta tools.
  - Every name referenced in descriptions and instructions resolves to a registered tool.
  - The committed manifest equals the production registration (49 tools, digest `414231f5d284`).
- Unit test: `/health` publishes the manifest.
