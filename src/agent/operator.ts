/**
 * Julian's channel (ADR-042). The LAUNCHER owns the terminal, never the agent:
 *  - hidden secret prompts go from Julian's keyboard to the provisioner, then to the destination store;
 *  - human-only actions are announced here and completed by Julian here (or detected by polling);
 *  - while an action is open, the browser-read guard keeps the agent from looking at the page.
 * The agent only ever sees statuses (no secrets) through the finagai tools.
 */
import readline from "node:readline";
import type { HumanAction, Prompter } from "../provision/io.js";
import { redact, Secret } from "../provision/secret.js";
import type { AgentStateFile } from "./state.js";

export interface Operator {
  say(text: string): void;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  waitDone(prompt: string): Promise<void>;
  showOnce(label: string, value: string): Promise<void>;
}

/** Terminal implementation: one prompt at a time; hidden input is never echoed. */
export class TerminalOperator implements Operator {
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }
  private q(question: string, muted: boolean): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (muted) {
        const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
        r._writeToOutput = (s: string) => { if (s.startsWith(question)) r.output.write(question); };
      }
      rl.question(question, (a) => { rl.close(); if (muted) process.stdout.write("\n"); resolve(a.trim()); });
    });
  }
  say(text: string) { process.stdout.write(`${redact(text)}\n`); }
  ask(question: string) { return this.serial(() => this.q(`\n[Finagai needs you] ${question} `, false)); }
  askHidden(question: string) { return this.serial(() => this.q(`\n[Finagai needs you] ${question} (input hidden) `, true)); }
  waitDone(prompt: string) { return this.serial(async () => { await this.q(`${prompt} Press Enter when done. `, false); }); }
  showOnce(label: string, value: string) {
    return this.serial(async () => {
      process.stdout.write(`\n=== ${label} ===\n  ${value}\n`); // deliberate, the only unredacted output: Julian must save it
      await this.q("  Saved it? Press Enter to clear the screen. ", false);
      process.stdout.write("\x1b[2J\x1b[H");
    });
  }
}

/** Tracks open human-only actions; one may be open at a time per id. */
export class HumanDesk {
  private open = new Map<string, Promise<void>>();
  constructor(private readonly op: Operator, private readonly state: AgentStateFile) {}

  get takeoverActive(): boolean { return this.open.size > 0; }
  isOpen(id: string): boolean { return this.open.has(id); }

  /** Announces the action and resolves once it is done (polling when possible, otherwise Julian confirms). */
  begin(id: string, a: HumanAction): Promise<void> {
    const existing = this.open.get(id);
    if (existing) return existing;
    const lines = [`\n=== YOUR ACTION: ${a.title} ===`, ...a.steps.map((s, i) => `  ${i + 1}. ${s}`), ...(a.url ? [`  Link: ${a.url}`] : [])];
    this.op.say(lines.join("\n"));
    this.state.update((s) => { s.status = "waiting_human"; s.pendingHuman = { id, title: a.title, steps: a.steps, ...(a.url ? { url: a.url } : {}), since: new Date().toISOString() }; });
    const done = (async () => {
      if (a.waitFor) {
        this.op.say("  Finagai continues by itself once this is detected.");
        for (;;) {
          if (await a.waitFor().catch(() => false)) break;
          await new Promise((r) => setTimeout(r, a.pollMs ?? 10_000));
        }
      } else {
        await this.op.waitDone("  When you have finished,");
      }
      this.op.say(`  Done: ${a.title}. Continuing.`);
    })().finally(() => {
      this.open.delete(id);
      this.state.update((s) => { if (s.pendingHuman?.id === id) { delete s.pendingHuman; s.status = "running"; } });
    });
    this.open.set(id, done);
    return done;
  }
}

/** The provisioner's Prompter, routed to Julian's terminal through the desk. */
export function provisionPrompter(op: Operator, desk: HumanDesk): Prompter & { showSecretOnce(label: string, s: Secret): Promise<void> } {
  return {
    ask: (_id, q) => op.ask(q),
    async askSecret(_id, q, validate) {
      for (;;) {
        const v = await op.askHidden(q);
        if (!v) continue;
        const s = new Secret(v);
        const problem = validate ? await validate(s) : null;
        if (!problem) { op.say("  accepted"); return s; }
        op.say(`  not accepted: ${problem}. Try again.`);
      }
    },
    act: (id, a) => desk.begin(id, a),
    showSecretOnce: (label, s) => op.showOnce(label, s.reveal()),
  };
}
