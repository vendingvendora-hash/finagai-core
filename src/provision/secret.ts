/**
 * Secrets in the bootstrapper. A Secret never prints: toString, JSON, and inspection all yield
 * "[secret]". Every value is registered so the logger and the state writer can refuse or redact it.
 */
import { inspect } from "node:util";

const registry = new Set<string>();

export class Secret {
  readonly #value: string;
  constructor(value: string) {
    if (!value) throw new Error("empty secret");
    this.#value = value;
    registry.add(value);
  }
  reveal(): string { return this.#value; }
  toString(): string { return "[secret]"; }
  toJSON(): string { return "[secret]"; }
  [inspect.custom](): string { return "[secret]"; }
}

/** Replaces every registered secret (raw and URL-encoded) in arbitrary text. */
export function redact(text: string): string {
  let out = text;
  for (const v of registry) {
    if (v.length < 6) continue;
    for (const form of new Set([v, encodeURIComponent(v)])) out = out.split(form).join("[secret]");
  }
  return out;
}

export function containsSecret(text: string): boolean {
  for (const v of registry) if (v.length >= 6 && (text.includes(v) || text.includes(encodeURIComponent(v)))) return true;
  return false;
}
