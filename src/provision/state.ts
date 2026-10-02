/**
 * Provisioning state: identifiers and step status only, never secrets (the writer refuses them).
 * Deleting the file is safe; every step re-detects from the providers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { containsSecret } from "./secret.js";

export interface ProvisionState {
  version: 1;
  values: Record<string, string>;
  steps: Record<string, { status: "done" | "waiting" | "failed"; at: string; detail?: string }>;
}

export class StateFile {
  data: ProvisionState;
  constructor(private readonly path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ProvisionState : { version: 1, values: {}, steps: {} };
  }
  get(k: string): string | undefined { return this.data.values[k]; }
  set(k: string, v: string): void {
    if (containsSecret(v)) throw new Error(`refusing to write a secret into the state file (${k})`);
    this.data.values[k] = v;
    this.save();
  }
  step(id: string, status: "done" | "waiting" | "failed", detail?: string): void {
    if (detail && containsSecret(detail)) detail = "[detail withheld: contained a secret]";
    this.data.steps[id] = { status, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
    this.save();
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}
