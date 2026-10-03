/**
 * Typed configuration for Finagai Core.
 *
 * Secrets are read ONLY here (Implementation Plan section 14). No other module reads process.env,
 * and no configuration value is ever returned by a tool or included in a prompt (ADR-004, ADR-020).
 */
import { z } from "zod";

/** Placeholders look like <lowercase-words>; a real "Name <a@b.c>" sender never matches. */
const PLACEHOLDER = /<[a-z0-9]+(?:-[a-z0-9]+)*>/;
const positiveInt = z.coerce.number().int().positive();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h)");

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  FINAGAI_PUBLIC_BASE_URL: z.string().url(),
  FINAGAI_MCP_RESOURCE_URL: z.string().url(),
  FINAGAI_TIMEZONE: z.string().default("America/New_York"),

  DATABASE_URL: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  MODEL_J2_EXTRACT: z.string().default("claude-sonnet-5-5"),
  MODEL_J2_CLASSIFY: z.string().default("claude-sonnet-5-5"),
  MODEL_J3_COMPOSE: z.string().default("claude-sonnet-5-5"),
  MODEL_J3_SHADOW: z.string().default("claude-opus-5-5"),
  MODEL_EVAL_GRADER: z.string().default("claude-opus-5-5"),
  /** J5 ticket concierge (ADR-044). */
  MODEL_J5_CONCIERGE: z.string().default("claude-sonnet-5-5"),
  /** J6 Mac-control planner: the hard reasoning runs on the strongest model (ADR-055). */
  MODEL_J6_PLANNER: z.string().default("claude-opus-5-5"),
  /** Extended-thinking token budget for the J6 planner; 0 disables. */
  J6_THINKING_TOKENS: z.coerce.number().int().min(0).max(8000).default(2000),
  /** Shared secret of the Mac iMessage helper; J5 endpoints are disabled while unset. */
  CONCIERGE_HELPER_TOKEN: z.string().min(32).optional(),
  /** Read-only Google access for J5 (ADR-049); all three or none. */
  GOOGLE_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
  GOOGLE_REFRESH_TOKEN: z.string().min(10).optional(),
  /** Searches allowed per concierge draft. */
  CONCIERGE_MAX_SEARCHES: z.coerce.number().int().min(0).max(5).default(3),
  /** ADR-025 (clarified): normal Lean pilot budget. */
  MODEL_BUDGET_TARGET_USD_MONTH: z.coerce.number().positive().default(30),
  /** ADR-025 (clarified): absolute model-API ceiling; changed only by Julian. */
  MODEL_HARD_CEILING_USD_MONTH: z.coerce.number().positive().default(36),
  /** J2 deferred-capture queue bound; alert at 80%. */
  MAX_DEFERRED_CAPTURES: z.coerce.number().int().positive().default(200),

  OAUTH_ISSUER: z.string().url(),
  OAUTH_JWKS_URL: z.string().url(),
  PRINCIPAL_SUBJECT: z.string().min(1),
  APPROVAL_CLIENT_ID: z.string().min(1),
  /** Comma-separated client IDs allowed on /mcp. Empty until Claude's client ID is observed at M3. */
  ALLOWED_MCP_CLIENT_IDS: z.string().default("").transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean)),
  /** WebAuthn relying party for the approval page; derived from FINAGAI_PUBLIC_BASE_URL when unset. */
  WEBAUTHN_RP_ID: z.string().optional(),
  APPROVAL_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),

  RESEND_API_KEY: z.string().min(1),
  NOTIFY_FROM: z.string().min(3),
  NOTIFY_TO: z.string().email(),
  NOTIFY_REPLY_TO: z.string().email(),

  WEEKLY_REVIEW_DAY: z.coerce.number().int().min(0).max(6).default(1), // 0 = Sunday, 1 = Monday
  WEEKLY_REVIEW_TIME: hhmm.default("07:00"),
  MISSED_RUN_CHECK_TIME: hhmm.default("09:00"),
  STALL_THRESHOLD_DAYS: positiveInt.default(14),
  UPCOMING_WINDOW_DAYS: positiveInt.default(14),
  PRIORITY_UPCOMING_WINDOW_DAYS: positiveInt.default(30),
  GOVERNANCE_REQUEST_TTL_HOURS: positiveInt.default(72),
  RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS: positiveInt.default(180),
  PUBLIC_PROFESSIONAL_REVERIFY_DAYS: positiveInt.default(365),
  PUBLIC_FACT_FRESHNESS_WARNING_DAYS: positiveInt.default(120),
});

export type Config = z.infer<typeof configSchema>;

/** Keys whose values are secrets: never logged, never echoed in errors, never in model context. */
export const SECRET_KEYS = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "APPROVAL_CLIENT_SECRET",
  "SESSION_SECRET",
  "RESEND_API_KEY",
  "CONCIERGE_HELPER_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const satisfies readonly (keyof Config)[];

/** Keys that must hold real values (no angle-bracket placeholders) in production. */
const MUST_BE_REAL: readonly (keyof Config)[] = [
  ...SECRET_KEYS,
  "FINAGAI_PUBLIC_BASE_URL",
  "FINAGAI_MCP_RESOURCE_URL",
  "OAUTH_ISSUER",
  "OAUTH_JWKS_URL",
  "PRINCIPAL_SUBJECT",
  "APPROVAL_CLIENT_ID",
  "NOTIFY_FROM",
  "NOTIFY_TO",
  "NOTIFY_REPLY_TO",
];

export class ConfigError extends Error {}

/** Parse configuration from an environment map. Error messages name keys, never values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  const cfg = parsed.data;
  if (cfg.MODEL_HARD_CEILING_USD_MONTH < cfg.MODEL_BUDGET_TARGET_USD_MONTH) {
    throw new ConfigError("MODEL_HARD_CEILING_USD_MONTH must be at least MODEL_BUDGET_TARGET_USD_MONTH");
  }
  if (cfg.NODE_ENV === "production") {
    const bad = MUST_BE_REAL.filter((k) => PLACEHOLDER.test(String(cfg[k])));
    if (bad.length > 0) throw new ConfigError(`Placeholder values remain for: ${bad.join(", ")}`);
    if (!cfg.FINAGAI_MCP_RESOURCE_URL.startsWith("https://")) {
      throw new ConfigError("FINAGAI_MCP_RESOURCE_URL must use https in production");
    }
  }
  return cfg;
}

/** Replace secret values with a fixed marker; used by the log scrubber (acceptance A7). */
export function redactSecrets(text: string, cfg: Pick<Config, (typeof SECRET_KEYS)[number]>): string {
  let out = text;
  for (const k of SECRET_KEYS) {
    const v = cfg[k];
    if (v && v.length >= 8) out = out.split(v).join(`[redacted:${k}]`);
  }
  return out;
}
