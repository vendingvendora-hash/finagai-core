/**
 * M5: the governance approval page (ADR-019, ADR-030). Browser-only: bearer tokens are refused
 * before this handler runs. Every state-changing POST requires the approval session cookie, a
 * same-origin Origin header, and a JSON body. Cryptography is delegated to @simplewebauthn/server.
 */
import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";
import type pg from "pg";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { appendEvent, withTransaction } from "../db/index.js";
import { executeGovernanceDecision, type PromoteSeedBatch } from "../governance/execute.js";
import type { OidcClient } from "./oidc.js";
import { readCookie, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionCookieHeader, signSession, verifySession, type ApprovalSession } from "./session.js";
import { computeApprovalChallenge, hashChallenge, verifyGovernanceApproval, type StoredCredential } from "./webauthn.js";

export interface ApprovalConfig {
  publicBaseUrl: string;
  rpId: string;
  rpName: string;
  principalSubject: string;
  sessionSecret: string;
}

export interface ApprovalDeps {
  pool: pg.Pool;
  cfg: ApprovalConfig;
  oidc: OidcClient;
  promote?: PromoteSeedBatch;
  /** Runs after a successful execution (for example the baseline J3 review after seed promotion). */
  onExecuted?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  nowSec?: () => number;
}

const LOGIN_COOKIE = "finagai_login";
const CEREMONY_TTL_MIN = 5;
const MAX_BODY = 64_000;

// ------------------------------------------------------------------------------------- helpers

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function html(res: http.ServerResponse, status: number, title: string, body: string, script = "", extraHeaders: Record<string, string | string[]> = {}) {
  const nonce = randomBytes(16).toString("base64");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    ...extraHeaders,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
pre{background:#f4f4f4;padding:.75rem;overflow-x:auto;white-space:pre-wrap}button{font-size:1rem;padding:.6rem 1.2rem;margin-right:.75rem}
.warn{color:#8a1c1c}</style></head><body><h1>${esc(title)}</h1>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error("body too large"); chunks.push(c as Buffer); }
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  return v as Record<string, unknown>;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const B64 = `const toBuf=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0)).buffer;
const toB64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const post=async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return {ok:r.ok,body:await r.json()}};
const show=t=>{document.getElementById('status').textContent=t};
const assertion=c=>({id:c.id,rawId:toB64(c.rawId),type:c.type,clientExtensionResults:{},response:{authenticatorData:toB64(c.response.authenticatorData),clientDataJSON:toB64(c.response.clientDataJSON),signature:toB64(c.response.signature),userHandle:c.response.userHandle?toB64(c.response.userHandle):undefined}});
const getOpts=o=>({publicKey:{challenge:toBuf(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:(o.allowCredentials||[]).map(c=>({type:'public-key',id:toBuf(c.id)}))}});`;

// ------------------------------------------------------------------------------------- handler

export function createApprovalHandler(deps: ApprovalDeps) {
  const { pool, cfg } = deps;
  const origin = new URL(cfg.publicBaseUrl).origin;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const session = (req: http.IncomingMessage): ApprovalSession | null =>
    verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), cfg.sessionSecret, cfg.principalSubject, nowSec());

  /** Same-origin JSON POST with a valid session, or a refusal. */
  function guardPost(req: http.IncomingMessage, res: http.ServerResponse): ApprovalSession | null {
    if (req.headers.origin !== origin) { json(res, 403, { error: "cross_origin_refused" }); return null; }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) { json(res, 415, { error: "json_required" }); return null; }
    const s = session(req);
    if (!s) { json(res, 401, { error: "sign_in_required" }); return null; }
    return s;
  }

  async function activeCredentials(): Promise<StoredCredential[]> {
    const r = await pool.query<{ id: string; credential_id: string; public_key: Buffer; sign_count: string; transports: string[]; principal_subject: string; revoked_at: Date | null }>(
      `SELECT id, credential_id, public_key, sign_count, transports, principal_subject, revoked_at FROM webauthn_credential
        WHERE principal_subject = $1 AND revoked_at IS NULL`, [cfg.principalSubject]);
    return r.rows.map((c) => ({ id: c.id, credentialId: c.credential_id, publicKey: new Uint8Array(c.public_key),
      signCount: Number(c.sign_count), transports: c.transports, principalSubject: c.principal_subject, revokedAt: c.revoked_at }));
  }

  async function registrationOptions(ceremony: { enrollmentId?: string; authorizedBy?: string }) {
    const existing = await activeCredentials();
    const opts = await generateRegistrationOptions({
      rpName: cfg.rpName, rpID: cfg.rpId, userName: "Julian", userID: createHash("sha256").update(cfg.principalSubject).digest(),
      attestationType: "none", authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    });
    const row = (await pool.query<{ id: string }>(
      `INSERT INTO webauthn_ceremony (kind, principal_subject, challenge, enrollment_id, authorized_by_credential, expires_at)
       VALUES ('registration', $1, $2, $3, $4, now() + ($5 * interval '1 minute')) RETURNING id`,
      [cfg.principalSubject, opts.challenge, ceremony.enrollmentId ?? null, ceremony.authorizedBy ?? null, CEREMONY_TTL_MIN])).rows[0]!;
    return { ceremonyId: row.id, options: opts };
  }

  async function loadRequest(id: string) {
    return (await pool.query(`SELECT * FROM governance_request WHERE id = $1`, [id])).rows[0] as Record<string, any> | undefined;
  }

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      // ---------------------------------------------------------------- sign-in
      if (method === "GET" && path === "/approve/login") {
        const { redirect, loginCookie } = await deps.oidc.begin(url.searchParams.get("return") ?? "/approve");
        res.writeHead(302, { location: redirect, "cache-control": "no-store",
          "set-cookie": `${LOGIN_COOKIE}=${loginCookie}; Path=/approve; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
        res.end();
        return;
      }
      if (method === "GET" && path === "/approve/callback") {
        const done = await deps.oidc.complete(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "",
          readCookie(req.headers.cookie, LOGIN_COOKIE));
        const cookie = signSession({ sub: done.sub, authTime: done.authTime, exp: nowSec() + SESSION_MAX_AGE_SECONDS }, cfg.sessionSecret);
        // A same-site click (not a redirect) so the SameSite=Strict session cookie is sent next.
        return html(res, 200, "Signed in", `<p><a href="${esc(done.returnTo)}">Continue</a></p>`, "", {
          "set-cookie": [sessionCookieHeader(cookie), `${LOGIN_COOKIE}=; Path=/approve; HttpOnly; Secure; SameSite=Lax; Max-Age=0`] });
      }

      const s = method === "GET" ? session(req) : null;
      if (method === "GET" && !s) {
        res.writeHead(302, { location: `/approve/login?return=${encodeURIComponent(path + url.search)}`, "cache-control": "no-store" });
        res.end();
        return;
      }

      // ---------------------------------------------------------------- enrollment
      if (method === "GET" && path === "/approve/enroll") {
        const first = (await activeCredentials()).length === 0;
        return html(res, 200, "Register a passkey for Finagai approvals",
          first ? `<p>Enter the one-time code shown by the admin CLI on your machine.</p><p><input id="code" autocomplete="off"></p><button id="go">Register passkey</button><p id="status"></p>`
                : `<p>Confirm with an existing passkey, then register the new one.</p><button id="go">Register another passkey</button><p id="status"></p>`,
          `${B64}
document.getElementById('go').onclick=async()=>{try{
 const codeEl=document.getElementById('code');let b=await post('/approve/enroll/begin',{code:codeEl?codeEl.value.trim():undefined});
 if(!b.ok)return show(b.body.error);
 if(b.body.authenticate){const a=await navigator.credentials.get(getOpts(b.body.authenticate));b=await post('/approve/enroll/authorize',{ceremonyId:b.body.ceremonyId,response:assertion(a)});if(!b.ok)return show(b.body.error);}
 const o=b.body.options;const c=await navigator.credentials.create({publicKey:{...o,challenge:toBuf(o.challenge),user:{...o.user,id:toBuf(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(x=>({type:'public-key',id:toBuf(x.id)}))}});
 const r=await post('/approve/enroll/finish',{ceremonyId:b.body.ceremonyId,response:{id:c.id,rawId:toB64(c.rawId),type:c.type,clientExtensionResults:{},response:{clientDataJSON:toB64(c.response.clientDataJSON),attestationObject:toB64(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]}}});
 show(r.ok?'Passkey registered.':r.body.error)}catch(e){show('Cancelled or failed: '+e.message)}};`);
      }
      if (method === "POST" && path === "/approve/enroll/begin") {
        const sess = guardPost(req, res); if (!sess) return;
        const body = await readJson(req);
        const existing = await activeCredentials();
        if (existing.length === 0) {
          const code = typeof body.code === "string" ? body.code : "";
          const e = (await pool.query<{ id: string }>(
            `SELECT id FROM webauthn_enrollment WHERE code_hash = $1 AND principal_subject = $2 AND used_at IS NULL AND expires_at > now()`,
            [sha256hex(code), cfg.principalSubject])).rows[0];
          if (!e) return json(res, 403, { error: "invalid_or_expired_enrollment_code" });
          const r = await registrationOptions({ enrollmentId: e.id });
          return json(res, 200, r);
        }
        // Later credentials require an assertion from an existing one (ADR-030).
        const opts = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: "required",
          allowCredentials: existing.map((c) => ({ id: c.credentialId })) });
        const row = (await pool.query<{ id: string }>(
          `INSERT INTO webauthn_ceremony (kind, principal_subject, challenge, expires_at) VALUES ('enroll_auth', $1, $2, now() + ($3 * interval '1 minute')) RETURNING id`,
          [cfg.principalSubject, opts.challenge, CEREMONY_TTL_MIN])).rows[0]!;
        return json(res, 200, { ceremonyId: row.id, authenticate: { challenge: opts.challenge, rpId: cfg.rpId, timeout: opts.timeout,
          allowCredentials: existing.map((c) => ({ id: c.credentialId })) } });
      }
      if (method === "POST" && path === "/approve/enroll/authorize") {
        const sess = guardPost(req, res); if (!sess) return;
        const body = await readJson(req);
        const response = body.response as AuthenticationResponseJSON;
        const cer = (await pool.query(`UPDATE webauthn_ceremony SET used_at = now() WHERE id = $1 AND kind = 'enroll_auth' AND used_at IS NULL
                                         AND expires_at > now() AND principal_subject = $2 RETURNING challenge`, [body.ceremonyId, cfg.principalSubject])).rows[0];
        if (!cer) return json(res, 403, { error: "ceremony_invalid_or_used" });
        const cred = (await activeCredentials()).find((c) => c.credentialId === response?.id);
        if (!cred) return json(res, 403, { error: "unknown_or_revoked_credential" });
        const v = await verifyAuthenticationResponse({ response, expectedChallenge: cer.challenge, expectedOrigin: origin, expectedRPID: cfg.rpId,
          requireUserVerification: true, credential: { id: cred.credentialId, publicKey: cred.publicKey as never, counter: cred.signCount } }).catch(() => null);
        if (!v?.verified || !v.authenticationInfo.userVerified) return json(res, 403, { error: "assertion_invalid" });
        await pool.query(`UPDATE webauthn_credential SET sign_count = $2, last_used_at = now() WHERE id = $1`, [cred.id, v.authenticationInfo.newCounter]);
        return json(res, 200, await registrationOptions({ authorizedBy: cred.id }));
      }
      if (method === "POST" && path === "/approve/enroll/finish") {
        const sess = guardPost(req, res); if (!sess) return;
        const body = await readJson(req);
        const result = await withTransaction(pool, async (tx) => {
          const cer = (await tx.query(`UPDATE webauthn_ceremony SET used_at = now() WHERE id = $1 AND kind = 'registration' AND used_at IS NULL
                                         AND expires_at > now() AND principal_subject = $2 RETURNING challenge, enrollment_id, authorized_by_credential`,
            [body.ceremonyId, cfg.principalSubject])).rows[0];
          if (!cer) return { error: "ceremony_invalid_or_used" };
          if (cer.enrollment_id) {
            const used = await tx.query(`UPDATE webauthn_enrollment SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now()`, [cer.enrollment_id]);
            if (used.rowCount !== 1) return { error: "enrollment_code_already_used" };
          }
          const v = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: cer.challenge,
            expectedOrigin: origin, expectedRPID: cfg.rpId, requireUserVerification: true }).catch(() => null);
          if (!v?.verified || !v.registrationInfo) return { error: "registration_invalid" };
          const c = v.registrationInfo.credential;
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO webauthn_credential (principal_subject, credential_id, public_key, sign_count, transports, enrolled_via)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [cfg.principalSubject, c.id, Buffer.from(c.publicKey), c.counter, c.transports ?? [],
             cer.enrollment_id ? "admin_enrollment_code" : "existing_credential"]);
          await appendEvent(tx, { actor: "julian", action: "passkey_enrolled", entityType: "webauthn_credential", entityId: ins.rows[0]!.id,
            principal: sess.sub, client: "approval_page" });
          return { credential: ins.rows[0]!.id };
        });
        return json(res, "error" in result ? 403 : 200, result);
      }

      // ---------------------------------------------------------------- approval
      const m = /^\/approve\/([0-9a-f-]{36})(\/challenge|\/decide)?$/.exec(path);
      if (!m) return json(res, 404, { error: "not_found" });
      const id = m[1]!;
      const action = m[2] ?? "";

      if (method === "GET" && action === "") {
        const r = await loadRequest(id);
        const nonce = url.searchParams.get("n") ?? "";
        if (!r || sha256hex(nonce) !== r.nonce_hash) return html(res, 404, "Approval request not found", "<p>This link is not valid.</p>");
        if (r.status !== "pending" || new Date(r.expires_at).getTime() <= Date.now()) {
          return html(res, 410, "Approval request closed", `<p>This request is <strong>${esc(r.status === "pending" ? "expired" : r.status)}</strong>. Nothing can be approved from this link.</p>`);
        }
        const hasCred = (await activeCredentials()).length > 0;
        return html(res, 200, `Approve: ${String(r.action).replace(/_/g, " ")}`,
          `<p>Requested by <strong>${esc(r.requesting_client)}</strong> at ${esc(new Date(r.requested_at).toISOString())}. Expires ${esc(new Date(r.expires_at).toISOString())}.</p>
<h2>Reason</h2><p>${esc(r.rationale)}</p>
<h2>Before</h2><pre>${esc(JSON.stringify(r.before_state, null, 2))}</pre>
<h2>After (if approved)</h2><pre>${esc(JSON.stringify(r.proposed_after_state, null, 2))}</pre>
<h2>Source</h2><pre>${esc(JSON.stringify(r.source_ref ?? {}, null, 2))}</pre>
${hasCred ? `<button id="approve">Approve with passkey</button><button id="reject">Reject with passkey</button>` : `<p class="warn">Register a passkey first: <a href="/approve/enroll">enroll</a>.</p>`}
<p id="status"></p>`,
          hasCred ? `${B64}
const ctx=${JSON.stringify({ nonce, contentHash: r.content_hash })};
const go=async d=>{try{let c=await post(location.pathname+'/challenge',{...ctx,decision:d});if(!c.ok)return show(c.body.error);
 const a=await navigator.credentials.get(getOpts(c.body));const r=await post(location.pathname+'/decide',{...ctx,response:assertion(a)});
 show(r.ok?('Done: '+r.body.result):('Refused: '+(r.body.reason||r.body.error)))}catch(e){show('Cancelled or failed: '+e.message)}};
document.getElementById('approve').onclick=()=>go('approve');document.getElementById('reject').onclick=()=>go('reject');` : "");
      }

      if (method === "POST" && action === "/challenge") {
        const sess = guardPost(req, res); if (!sess) return;
        const body = await readJson(req);
        const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
        const r = await loadRequest(id);
        if (!r || !decision || typeof body.nonce !== "string" || sha256hex(body.nonce) !== r.nonce_hash) return json(res, 403, { error: "request_invalid" });
        if (r.status !== "pending" || new Date(r.expires_at).getTime() <= Date.now()) return json(res, 409, { error: "request_closed" });
        if (body.contentHash !== r.content_hash) return json(res, 409, { error: "content_changed" });
        const creds = await activeCredentials();
        if (creds.length === 0) return json(res, 409, { error: "no_passkey_enrolled" });
        const random = randomBytes(32);
        const challenge = computeApprovalChallenge(r.id, body.nonce, r.content_hash, random);
        const upd = await pool.query(
          `UPDATE governance_request SET challenge_hash = $2, challenge_random = $3, challenge_decision = $4,
                  challenge_expires_at = now() + ($5 * interval '1 minute'), challenge_used_at = NULL
            WHERE id = $1 AND status = 'pending'`,
          [r.id, hashChallenge(challenge), random.toString("base64url"), decision, CEREMONY_TTL_MIN]);
        if (upd.rowCount !== 1) return json(res, 409, { error: "request_closed" });
        return json(res, 200, { challenge, rpId: cfg.rpId, timeout: CEREMONY_TTL_MIN * 60_000, userVerification: "required",
          allowCredentials: creds.map((c) => ({ id: c.credentialId })) });
      }

      if (method === "POST" && action === "/decide") {
        const sess = guardPost(req, res); if (!sess) return;
        const body = await readJson(req);
        const r = await loadRequest(id);
        const response = body.response as AuthenticationResponseJSON | undefined;
        if (!r || typeof body.nonce !== "string" || !response || typeof response.id !== "string") return json(res, 403, { error: "request_invalid" });
        if (!r.challenge_random) return json(res, 409, { error: "no_active_challenge" });
        const credRow = (await pool.query<{ id: string; credential_id: string; public_key: Buffer; sign_count: string; transports: string[]; principal_subject: string; revoked_at: Date | null }>(
          `SELECT id, credential_id, public_key, sign_count, transports, principal_subject, revoked_at FROM webauthn_credential WHERE credential_id = $1`,
          [response.id])).rows[0];
        if (!credRow) return json(res, 403, { error: "unknown_credential" });
        const credential: StoredCredential = { id: credRow.id, credentialId: credRow.credential_id, publicKey: new Uint8Array(credRow.public_key),
          signCount: Number(credRow.sign_count), transports: credRow.transports, principalSubject: credRow.principal_subject, revokedAt: credRow.revoked_at };
        const challenge = computeApprovalChallenge(r.id, body.nonce, r.content_hash, Buffer.from(r.challenge_random, "base64url"));
        const verdict = await verifyGovernanceApproval({
          sessionSubject: sess.sub, principalSubject: cfg.principalSubject,
          request: { id: r.id, status: r.status, expiresAt: new Date(r.expires_at), nonce: body.nonce, nonceHash: r.nonce_hash,
            contentHash: r.content_hash, challengeHash: r.challenge_hash, challengeExpiresAt: r.challenge_expires_at ? new Date(r.challenge_expires_at) : null,
            challengeUsedAt: r.challenge_used_at ? new Date(r.challenge_used_at) : null },
          displayedContentHash: typeof body.contentHash === "string" ? body.contentHash : "",
          challenge, credential, response, expectedOrigin: origin, expectedRPID: cfg.rpId, now: new Date(),
        });
        if (!verdict.ok) {
          await appendEvent(pool, { actor: "system", action: "governance_approval_refused", entityType: "governance_request", entityId: r.id,
            reason: verdict.reason, client: "approval_page" });
          return json(res, 403, { error: "approval_refused", reason: verdict.reason });
        }
        const result = await executeGovernanceDecision(pool, { requestId: r.id, challengeHash: hashChallenge(challenge), principal: sess.sub,
          credentialUuid: credential.id, previousSignCount: credential.signCount, newSignCount: verdict.newSignCount }, deps.promote);
        if (result.kind === "executed" && deps.onExecuted) deps.onExecuted(String(r.action), result.detail).catch(() => {});
        const status = result.kind === "executed" || result.kind === "rejected" ? 200 : result.kind === "superseded" ? 409 : 403;
        return json(res, status, { result: result.kind, ...("reason" in result ? { reason: result.reason } : {}),
          ...("detail" in result ? { detail: result.detail } : {}) });
      }

      return json(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      return json(res, 400, { error: "bad_request", reason: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  };
}
