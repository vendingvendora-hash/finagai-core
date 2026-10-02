import { describe, expect, it } from "vitest";
import { loadConfig, redactSecrets, ConfigError } from "../../src/config/index.js";

const base = {
  FINAGAI_PUBLIC_BASE_URL: "https://core.example.test",
  FINAGAI_MCP_RESOURCE_URL: "https://core.example.test/mcp",
  DATABASE_URL: "postgres://finagai_app:canary-db-secret-123@db.example.test/finagai",
  ANTHROPIC_API_KEY: "canary-anthropic-secret-123",
  OAUTH_ISSUER: "https://auth.example.test",
  OAUTH_JWKS_URL: "https://auth.example.test/oauth2/jwks",
  PRINCIPAL_SUBJECT: "user_test",
  APPROVAL_CLIENT_ID: "client_test",
  APPROVAL_CLIENT_SECRET: "canary-approval-secret-123",
  SESSION_SECRET: "x".repeat(40),
  RESEND_API_KEY: "canary-resend-secret-123",
  NOTIFY_FROM: "Finagai <review@notify.example.test>",
  NOTIFY_TO: "julian@example.test",
  NOTIFY_REPLY_TO: "julian@example.test",
};

describe("config", () => {
  it("applies approved operating defaults (ADR-025, ADR-026)", () => {
    const cfg = loadConfig(base);
    expect(cfg.WEEKLY_REVIEW_DAY).toBe(1);
    expect(cfg.WEEKLY_REVIEW_TIME).toBe("07:00");
    expect(cfg.MISSED_RUN_CHECK_TIME).toBe("09:00");
    expect(cfg.STALL_THRESHOLD_DAYS).toBe(14);
    expect(cfg.UPCOMING_WINDOW_DAYS).toBe(14);
    expect(cfg.PRIORITY_UPCOMING_WINDOW_DAYS).toBe(30);
    expect(cfg.MODEL_BUDGET_TARGET_USD_MONTH).toBe(30);
    expect(cfg.MODEL_HARD_CEILING_USD_MONTH).toBe(36);
    expect(cfg.MAX_DEFERRED_CAPTURES).toBe(200);
    expect(cfg.FINAGAI_TIMEZONE).toBe("America/New_York");
  });

  it("rejects a hard ceiling below the budget target", () => {
    expect(() => loadConfig({ ...base, MODEL_BUDGET_TARGET_USD_MONTH: "30", MODEL_HARD_CEILING_USD_MONTH: "25" })).toThrow(/CEILING/);
  });

  it("rejects placeholders in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", PRINCIPAL_SUBJECT: "<julian-workos-user-id>" }),
    ).toThrow(/PRINCIPAL_SUBJECT/);
  });

  it("never includes secret values in error messages", () => {
    let msg = "";
    try {
      loadConfig({ ...base, NOTIFY_TO: "not-an-email" });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/NOTIFY_TO/);
    for (const v of [base.ANTHROPIC_API_KEY, base.RESEND_API_KEY, base.APPROVAL_CLIENT_SECRET, base.DATABASE_URL]) {
      expect(msg).not.toContain(v);
    }
  });

  it("redacts canary secrets from arbitrary text (acceptance A7)", () => {
    const cfg = loadConfig(base);
    const out = redactSecrets(`db ${base.DATABASE_URL} key ${base.ANTHROPIC_API_KEY}`, cfg);
    expect(out).not.toContain("canary-db-secret-123");
    expect(out).not.toContain(base.ANTHROPIC_API_KEY);
    expect(out).toContain("[redacted:ANTHROPIC_API_KEY]");
  });

  it("requires https for the MCP resource in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", FINAGAI_MCP_RESOURCE_URL: "http://core.example.test/mcp" }),
    ).toThrow(/https/);
  });
});

describe("placeholder detection", () => {
  it("accepts a real display-name sender in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).not.toThrow();
  });
  it("rejects the .env.example sender placeholder in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", NOTIFY_FROM: "Finagai <review@<sending-subdomain>>" }),
    ).toThrow(/NOTIFY_FROM/);
  });
});
