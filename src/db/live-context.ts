/**
 * ADR-087 — causal context for the Live State Stream. Code that starts a unit of work (an engine tick, a workflow
 * run, a tool call) wraps it in withCause(); every event appended inside inherits the correlation id, the causing
 * event ids and the Area, without each call site having to pass them. AsyncLocalStorage follows awaits.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * The unit of work itself, as a lazily-recorded event: the first STATE CHANGE inside a unit of work that has no more
 * specific cause records one `work_invoked` event (what was invoked, by whom) and cites it — so a state change made by a
 * tool call, a Mac report, a scheduled job or a detector pass always cites what caused it, and a unit of work that
 * changed nothing leaves no trace.
 */
export interface WorkRoot { actor: "julian" | "system" | "cos" | "j6" | "job"; what: string; detail?: Record<string, unknown>; id?: Promise<number> }
export interface CauseContext { correlationId?: string; causeIds?: number[]; areaId?: string | null; root?: WorkRoot }
const store = new AsyncLocalStorage<CauseContext>();

/** Run fn with this causal context layered over the current one (a new correlation id is minted only at the top). */
export function withCause<T>(ctx: CauseContext, fn: () => Promise<T>): Promise<T> {
  const parent = store.getStore() ?? {};
  const next: CauseContext = {
    correlationId: ctx.correlationId ?? parent.correlationId ?? randomUUID(),
    causeIds: ctx.causeIds ?? parent.causeIds ?? [],
    areaId: ctx.areaId !== undefined ? ctx.areaId : parent.areaId ?? null,
    ...(ctx.root ?? parent.root ? { root: ctx.root ?? parent.root } : {}),
  };
  return store.run(next, fn);
}
export const currentCause = (): CauseContext | undefined => store.getStore();
