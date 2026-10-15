/**
 * Command Center BFF configuration (ADR-089). Everything comes from the environment; nothing is defaulted that would
 * weaken security in production (cookies are Secure and __Host- prefixed unless CC_INSECURE_COOKIES=1, which only the
 * local test harness sets).
 */
export interface CcConfig {
  /** Public origin of this app, e.g. https://finagai-command.onrender.com (redirect URI = publicUrl + /auth/callback) */
  publicUrl: string;
  /** WorkOS AuthKit issuer — the same identity provider Core trusts (OAUTH_ISSUER) */
  issuer: string;
  /** The Command Center's own confidential OAuth client (a second client; never the MCP connector's) */
  clientId: string;
  clientSecret: string;
  /** Core's origin and the resource indicator Core requires as token audience (FINAGAI_MCP_RESOURCE_URL) */
  coreUrl: string;
  coreResource: string;
  /** Julian — the only principal (Core's PRINCIPAL_SUBJECT) */
  principalSubject: string;
  /** HMAC key for the short-lived sign-in state cookie */
  stateSecret: string;
  port: number;
  version: string;
  secureCookies: boolean;
  /** idle timeout of a session (ms) */
  sessionIdleMs: number;
  staticDir: string;
}

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing required setting ${k}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CcConfig {
  const secureCookies = env.CC_INSECURE_COOKIES !== "1";
  const publicUrl = need(env, "CC_PUBLIC_URL").replace(/\/$/, "");
  if (secureCookies && !publicUrl.startsWith("https://")) throw new Error("CC_PUBLIC_URL must be https");
  const stateSecret = need(env, "CC_STATE_SECRET");
  if (stateSecret.length < 32) throw new Error("CC_STATE_SECRET must be at least 32 characters");
  return {
    publicUrl,
    issuer: need(env, "OAUTH_ISSUER").replace(/\/$/, ""),
    clientId: need(env, "CC_CLIENT_ID"),
    clientSecret: need(env, "CC_CLIENT_SECRET"),
    coreUrl: need(env, "CORE_URL").replace(/\/$/, ""),
    coreResource: need(env, "CORE_RESOURCE"),
    principalSubject: need(env, "PRINCIPAL_SUBJECT"),
    stateSecret,
    port: Number(env.PORT ?? 8787),
    version: (env.RENDER_GIT_COMMIT ?? env.CC_VERSION ?? "dev").slice(0, 12),
    secureCookies,
    sessionIdleMs: Number(env.CC_SESSION_IDLE_MS ?? 12 * 3_600_000),
    staticDir: env.CC_STATIC_DIR ?? new URL("../web/", import.meta.url).pathname,
  };
}
