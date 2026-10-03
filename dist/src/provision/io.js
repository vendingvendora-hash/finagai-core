/** Terminal I/O for the bootstrapper: redacted logging, hidden secret prompts, and human-action pauses. */
import readline from "node:readline";
import { redact, Secret } from "./secret.js";
export const consoleLog = (line) => process.stdout.write(`${redact(line)}\n`);
/** Terminal prompter. Secret input is never echoed. */
export class TerminalPrompter {
    log;
    constructor(log = consoleLog) {
        this.log = log;
    }
    question(q, muted) {
        return new Promise((resolve) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
            if (muted) {
                const out = rl;
                out._writeToOutput = (s) => { if (s.startsWith(q))
                    out.output.write(q); };
            }
            rl.question(q, (a) => { rl.close(); if (muted)
                process.stdout.write("\n"); resolve(a.trim()); });
        });
    }
    ask(_id, question) { return this.question(`${question} `, false); }
    async askSecret(_id, question, validate) {
        for (;;) {
            const v = await this.question(`${question} (input hidden) `, true);
            if (!v)
                continue;
            const s = new Secret(v);
            const problem = validate ? await validate(s) : null;
            if (!problem) {
                this.log("  accepted");
                return s;
            }
            this.log(`  not accepted: ${problem}. Try again.`);
        }
    }
    /** The ONE deliberate exception to redaction: a value Julian must save himself (the backup key). */
    async showSecretOnce(label, s) {
        this.log(`\n=== ${label} ===`);
        process.stdout.write(`  ${s.reveal()}\n`); // direct to the terminal, bypassing the redacting logger on purpose
        await this.question("  Saved it? Press Enter to clear the screen and continue.", false);
        process.stdout.write("\x1b[2J\x1b[H");
    }
    async act(_id, a) {
        this.log(`\n=== YOUR ACTION: ${a.title} ===`);
        a.steps.forEach((s, i) => this.log(`  ${i + 1}. ${s}`));
        if (a.url)
            this.log(`  Link: ${a.url}`);
        if (a.waitFor) {
            this.log("  Waiting; this continues by itself once it is done (Ctrl-C to stop; re-running resumes).");
            for (;;) {
                if (await a.waitFor().catch(() => false)) {
                    this.log("  Done, continuing.");
                    return;
                }
                await new Promise((r) => setTimeout(r, a.pollMs ?? 10_000));
            }
        }
        await this.question("  Press Enter when done.", false);
    }
}
//# sourceMappingURL=io.js.map