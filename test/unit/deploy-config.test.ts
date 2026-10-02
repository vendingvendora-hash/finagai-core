/** The deployment manifest must supply every configuration key the service requires (no surprises at deploy). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema } from "../../src/config/index.js";

const blueprint = parse(readFileSync("render.yaml", "utf8")) as {
  envVarGroups: Array<{ name: string; envVars: Array<{ key: string; value?: string; sync?: boolean; generateValue?: boolean }> }>;
  services: Array<{ type: string; buildCommand: string; startCommand: string; healthCheckPath?: string; envVars: Array<{ fromGroup: string }> }>;
};
const group = blueprint.envVarGroups[0]!;
const keys = new Set(group.envVars.map((e) => e.key));

describe("render.yaml deployment manifest", () => {
  it("is a valid Blueprint: no sync:false inside the environment group (Render rejects it)", () => {
    expect(group.envVars.some((e) => e.sync === false)).toBe(false);
  });
  it("declares no secrets and never the migration role (the bootstrapper writes secrets via the API)", () => {
    for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "APPROVAL_CLIENT_SECRET", "RESEND_API_KEY", "SESSION_SECRET"]) expect(keys.has(k)).toBe(false);
    expect([...keys].some((k) => /MIGRATOR/.test(k))).toBe(false);
  });
  it("every required configuration key is either in the file or set by the bootstrapper", async () => {
    const { readFileSync: rf } = await import("node:fs");
    const steps = rf("src/provision/steps.ts", "utf8");
    const shape = configSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    const required = Object.keys(shape).filter((k) => !shape[k]!.safeParse(undefined).success);
    expect(required.filter((k) => !keys.has(k) && !steps.includes(k))).toEqual([]);
  });
  it("builds with dev dependencies (NODE_ENV=production would skip TypeScript) and points at real entry points", () => {
    for (const s of blueprint.services) {
      expect(s.buildCommand).toContain("--include=dev");
      expect(s.envVars).toEqual([{ fromGroup: group.name }]);
    }
    expect(blueprint.services.find((s) => s.type === "web")).toMatchObject({ startCommand: "node dist/src/server/index.js", healthCheckPath: "/health" });
    expect(blueprint.services.find((s) => s.type === "cron")?.startCommand).toBe("node dist/src/jobs/scheduler.js");
  });
});
