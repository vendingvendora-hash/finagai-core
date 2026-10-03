/**
 * Provisioning state: identifiers and step status only, never secrets (the writer refuses them).
 * Deleting the file is safe; every step re-detects from the providers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { containsSecret } from "./secret.js";
export class StateFile {
    path;
    data;
    constructor(path) {
        this.path = path;
        this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, values: {}, steps: {} };
    }
    get(k) { return this.data.values[k]; }
    set(k, v) {
        if (containsSecret(v))
            throw new Error(`refusing to write a secret into the state file (${k})`);
        this.data.values[k] = v;
        this.save();
    }
    step(id, status, detail) {
        if (detail && containsSecret(detail))
            detail = "[detail withheld: contained a secret]";
        this.data.steps[id] = { status, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
        this.save();
    }
    save() {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    }
}
//# sourceMappingURL=state.js.map