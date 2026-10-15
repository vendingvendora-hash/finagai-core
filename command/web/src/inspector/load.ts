/**
 * Loads what the Why inspector shows — two GETs through the BFF, nothing else:
 *   an object (`escalation:<id>`, …) → its most recent event: /api/live/history?entityType&entityId&order=desc&limit=1
 *   the chain behind that event      → /api/live/chain/<eventId>
 * Read-only by construction: Core serves both from SELECTs; opening the inspector writes nothing anywhere.
 */
import type { LiveEvent } from "../model/types";
import type { WhyTarget } from "./model";

export type WhyFailure = "not_found" | "offline" | "signed_out";
export class WhyLoadError extends Error { constructor(readonly reason: WhyFailure) { super(reason); } }
export interface WhyData { rootId: number; chain: LiveEvent[] }

async function get<T>(f: typeof fetch, path: string, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try { r = await f(path, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) }); }
  catch (e) { if (signal?.aborted) throw e; throw new WhyLoadError("offline"); }
  if (r.status === 401) throw new WhyLoadError("signed_out");
  if (r.status === 404) throw new WhyLoadError("not_found");
  if (!r.ok) throw new WhyLoadError("offline");
  return (await r.json()) as T;
}

export async function loadWhy(t: WhyTarget, f: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<WhyData> {
  let rootId: number;
  if (t.kind === "event") rootId = t.id;
  else {
    const q = new URLSearchParams({ entityType: t.type, entityId: t.id, order: "desc", limit: "1" });
    const h = await get<{ events: LiveEvent[] }>(f, `/api/live/history?${q}`, signal);
    const latest = h.events?.[0];
    if (!latest) throw new WhyLoadError("not_found");
    rootId = latest.eventId;
  }
  const c = await get<{ chain: LiveEvent[] }>(f, `/api/live/chain/${rootId}`, signal);
  if (!Array.isArray(c.chain) || !c.chain.some((e) => e.eventId === rootId)) throw new WhyLoadError("not_found");
  return { rootId, chain: c.chain };
}
