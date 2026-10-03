#!/usr/bin/env node
/**
 * One-time Google authorization for Finagai (ADR-049). Opens Google's consent page in your browser,
 * receives the answer on this Mac only (127.0.0.1), and copies three lines to your clipboard for Render's
 * "Add from .env" box. Scopes are read-only: Drive, Gmail, Calendar.
 *   node helper/google-auth.mjs        (asks for the client ID, then the client secret, hidden)
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly"];

function askHidden(q) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); res(a.trim()); });
  });
}

function ask(q) {
  return new Promise((res) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a.trim()); }); });
}
const clientId = process.argv[2] || await ask("Paste the Google Client ID (ends in .apps.googleusercontent.com), then Enter: ");
if (!clientId.endsWith(".apps.googleusercontent.com")) { console.error("That does not look like a Google Client ID. Run the command again."); process.exit(1); }
const clientSecret = await askHidden("Paste the Google client secret (hidden), then Enter: ");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") { res.writeHead(404).end(); return; }
  if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) { res.writeHead(400).end("Authorization failed. Close this tab and run the command again."); return; }
  const port = server.address().port;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: url.searchParams.get("code"), client_id: clientId, client_secret: clientSecret,
      redirect_uri: `http://127.0.0.1:${port}`, grant_type: "authorization_code", code_verifier: verifier }) });
  const j = await r.json();
  if (!j.refresh_token) { res.writeHead(500).end("Google did not return a long-lived token. Run the command again."); console.error("No refresh token:", j.error ?? "unknown"); process.exit(1); }
  const env = `GOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`;
  await new Promise((ok) => { const p = execFile("/usr/bin/pbcopy", ok); p.stdin.end(env); });
  res.writeHead(200, { "content-type": "text/html" }).end("<h2>Finagai is connected to your Google account (read-only).</h2><p>You can close this tab.</p>");
  console.log("\nDone. The three settings are in your clipboard. In Render, use 'Add from .env' and press Cmd+V.");
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" })) auth.searchParams.set(k, v);
  console.log("Opening Google in your browser. Choose your account and click Allow.");
  execFile("/usr/bin/open", [auth.toString()]);
});
