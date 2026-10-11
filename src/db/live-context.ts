/**
 * ADR-087 — causal context for the Live State Stream. Code that starts a unit of work (an engine tick, a workflow
 * run, a tool call) wraps it in withCause(); every event appended inside inherits the correlation id, the causing
 * event ids and the Area, without each call site having to pass them. AsyncLocalStorage follows awaits.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CauseContext { correlationId?: string; causeIds?: number[]; areaId?: string | null }
const store = new AsyncLocalStorage<CauseContext>();

/** Run fn with this causal context layered over the current one (a new correlation id is minted only at the top). */
export function withCause<T>(ctx: CauseContext, fn: () => Promise<T>): Promise<T> {
  const parent = store.getStore() ?? {};
  const next: CauseContext = {
    correlationId: ctx.correlationId ?? parent.correlationId ?? randomUUID(),
    causeIds: ctx.causeIds ?? parent.causeIds ?? [],
    areaId: ctx.areaId !== undefined ? ctx.areaId : parent.areaId ?? null,
  };
  return store.run(next, fn);
}
export const currentCause = (): CauseContext | undefined => store.getStore();
