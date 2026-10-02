/** Terminal I/O for the bootstrapper: redacted logging, hidden secret prompts, and human-action pauses. */
import readline from "node:readline";
import { redact, Secret } from "./secret.js";

export interface HumanAction {
  title: string;
  steps: string[];
  url?: string;
  /** If given, the bootstrapper polls it and continues by itself once it returns true. */
  waitFor?: () => Promise<boolean>;
  pollMs?: number;
}

export interface Prompter {
  ask(id: string, question: string): Promise<string>;
  askSecret(id: string, question: string, validate?: (s: Secret) => Promise<string | null>): Promise<Secret>;
  act(id: string, action: HumanAction): Promise<void>;
}

export type Log = (line: string) => void;
export const consoleLog: Log = (line) => process.stdout.write(`${redact(line)}\n`);

/** Terminal prompter. Secret input is never echoed. */
export class TerminalPrompter implements Prompter {
  constructor(private readonly log: Log = consoleLog) {}

  private question(q: string, muted: boolean): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (muted) {
        const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
        out._writeToOutput = (s: string) => { if (s.startsWith(q)) out.output.write(q); };
      }
      rl.question(q, (a) => { rl.close(); if (muted) process.stdout.write("\n"); resolve(a.trim()); });
    });
  }

  ask(_id: string, question: string) { return this.question(`${question} `, false); }

  async askSecret(_id: string, question: string, validate?: (s: Secret) => Promise<string | null>): Promise<Secret> {
    for (;;) {
      const v = await this.question(`${question} (input hidden) `, true);
      if (!v) continue;
      const s = new Secret(v);
      const problem = validate ? await validate(s) : null;
      if (!problem) { this.log("  accepted"); return s; }
      this.log(`  not accepted: ${problem}. Try again.`);
    }
  }

  /** The ONE deliberate exception to redaction: a value Julian must save himself (the backup key). */
  async showSecretOnce(label: string, s: Secret): Promise<void> {
    this.log(`\n=== ${label} ===`);
    process.stdout.write(`  ${s.reveal()}\n`); // direct to the terminal, bypassing the redacting logger on purpose
    await this.question("  Saved it? Press Enter to clear the screen and continue.", false);
    process.stdout.write("\x1b[2J\x1b[H");
  }

  async act(_id: string, a: HumanAction): Promise<void> {
    this.log(`\n=== YOUR ACTION: ${a.title} ===`);
    a.steps.forEach((s, i) => this.log(`  ${i + 1}. ${s}`));
    if (a.url) this.log(`  Link: ${a.url}`);
    if (a.waitFor) {
      this.log("  Waiting; this continues by itself once it is done (Ctrl-C to stop; re-running resumes).");
      for (;;) {
        if (await a.waitFor().catch(() => false)) { this.log("  Done, continuing."); return; }
        await new Promise((r) => setTimeout(r, a.pollMs ?? 10_000));
      }
    }
    await this.question("  Press Enter when done.", false);
  }
}
