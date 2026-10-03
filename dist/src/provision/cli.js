/**
 * `npm run provision` — Finagai bootstrapper (ADR-041). Run on Julian's machine from the repository.
 *   npm run provision               run or resume
 *   npm run provision -- --status   show recorded state, no provider calls
 *   npm run provision -- --plan     list steps and their last status
 * Credentials are typed into hidden prompts or created by providers, go straight to their destination,
 * and are never written to disk or printed (except the backup key, shown once for your password manager).
 */
import { writeFileSync } from "node:fs";
import { makeLocalExec } from "./exec.js";
import { join } from "node:path";
import { consoleLog, TerminalPrompter } from "./io.js";
import { StateFile } from "./state.js";
import { STEPS } from "./steps.js";
const repoDir = process.cwd();
const state = new StateFile(join(repoDir, ".finagai", "provision-state.json"));
const arg = process.argv[2];
if (arg === "--status" || arg === "--plan") {
    for (const s of STEPS) {
        const st = state.data.steps[s.id];
        consoleLog(`${(st?.status ?? "pending").padEnd(8)} ${s.title}${st?.detail ? ` — ${st.detail}` : ""}`);
    }
    if (arg === "--status")
        for (const [k, v] of Object.entries(state.data.values))
            consoleLog(`  ${k}: ${v}`);
    process.exit(0);
}
const ctx = {
    state, log: consoleLog, prompt: new TerminalPrompter(consoleLog), ep: {}, repoDir, vault: new Map(), pollMs: 10_000,
    db: { ssl: true },
    exec: makeLocalExec(repoDir, consoleLog),
};
const results = [];
for (const s of STEPS) {
    consoleLog(`\n▶ ${s.title}`);
    try {
        const detail = await s.run(ctx);
        state.step(s.id, "done", detail);
        results.push(`- ${s.title}: ${detail}`);
        consoleLog(`  ✓ ${detail}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "failed";
        state.step(s.id, "failed", msg);
        consoleLog(`  ✗ ${msg}\n\nFix that and run \`npm run provision\` again: finished work is detected and skipped.`);
        process.exit(1);
    }
}
const report = [`# Finagai provisioning report (${new Date().toISOString()})`, "", ...results, "",
    `Service: ${state.get("base_url")}`, `Identity: ${state.get("oauth_issuer")}`, `Sender: Finagai <review@notify.${state.get("sender_domain")}>`,
    "", "Send Claude this file (it contains no secrets)."].join("\n");
writeFileSync(join(repoDir, ".finagai", "provision-report.md"), report);
consoleLog(`\n${report}`);
//# sourceMappingURL=cli.js.map