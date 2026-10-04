/**
 * ADR-071 release gate: a deploy can never be triggered before a changed migration has been applied, and the
 * deploy job must not run if migration failed. Locks the workflow structure that fixes the recurring
 * push → failed-preflight → manual-redeploy race.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const wf = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const render = readFileSync(new URL("../../render.yaml", import.meta.url), "utf8");

describe("release gate (migrate before deploy)", () => {
  it("deploy depends on migrate and only proceeds when migrate succeeded or was skipped", () => {
    expect(wf).toMatch(/deploy:\s*\n\s*needs: \[detect, migrate\]/);
    expect(wf).toMatch(/needs\.migrate\.result == 'success' \|\| needs\.migrate\.result == 'skipped'/);
    expect(wf).not.toMatch(/needs\.migrate\.result == 'failure'/);
  });
  it("migrate runs under the production environment (human approval) and only when migrations changed", () => {
    expect(wf).toMatch(/migrate:[\s\S]*environment: production/);
    expect(wf).toMatch(/if: needs\.detect\.outputs\.migrations_changed == 'true'/);
  });
  it("Render auto-deploy is off in the blueprint so pushes cannot race the migration", () => {
    expect(render).toMatch(/autoDeploy: false/);
  });
  it("deploy verifies /health reports the released commit (no silent stale deploy)", () => {
    expect(wf).toMatch(/health/); expect(wf).toMatch(/GITHUB_SHA::7/);
  });
});
