# Operator runbook

Secrets are pasted only into the Render dashboard, GitHub secrets, or your local shell. Never into Claude.

## Deploy and migrate

- **Code:** merge to `main`; CI must be green; Render auto-deploys both services.
- **Migrations:** run the `migrate` workflow (Actions, then approve the `production` environment). A deploy whose code expects a migration that has not run refuses to start (preflight), so run `migrate` before or right after merging a migration.
- **Readiness:** run the `readiness` workflow any time; the summary shows each gate.

## Routine checks (weekly, 5 minutes)

- The weekly review arrived on Monday morning (otherwise the 09:00 missed-run check alerts or recovers it).
- The last `backup` run succeeded; the monthly `restore-drill` succeeded.
- Model spend in the review footer is below the $30 target.

## Incidents

| Symptom | Action |
| --- | --- |
| Email "scheduled job failed" | Render, then `finagai-scheduler` logs for that slot; the job is retried automatically within its 2-hour window; afterwards fix the cause and the next slot runs normally |
| Review lists "Delivery outcome unknown" | Check your inbox for that email. Nothing is resent automatically past the provider's deduplication window |
| Model-spend ceiling reached (degraded review) | Wait for the next month, or raise `MODEL_HARD_CEILING_USD_MONTH` in the Render environment group (your decision only). Captures blocked before classification must be resubmitted; deferred ones replay at 03:00 |
| Server will not start after a deploy | Render logs show `refusing to start` and the failing preflight check (wrong role, DELETE privilege, or migrations); fix the cause, no code change needed |
| Lost or compromised passkey | `npm run admin -- list-credentials`, then `npm run admin -- revoke-credential <id>`; enroll a new one with `npm run admin -- enroll-code` and `/approve/enroll` |
| Suspected leaked secret | Rotate it at the provider, update Render or GitHub, redeploy. `SESSION_SECRET` rotation signs everyone out of the approval page, nothing else |

## Restore

1. Prefer Neon point-in-time restore (last 7 days) from the Neon console.
2. Otherwise: new Neon database, run `migrate` against it, download the newest `finagai-backup` artifact, then locally: `BACKUP_ENCRYPTION_KEY=... RESTORE_DATABASE_URL=<migrator URL of the new database> node dist/src/backup/cli.js restore <file>`. The restore verifies every table checksum or changes nothing.
3. Point Render `DATABASE_URL` at the restored database (`finagai_app` role) and redeploy.

## Pin Claude's client ID (once, after the connector works)

Render logs show `mcp client id observed` with the client ID. Set `ALLOWED_MCP_CLIENT_IDS` to that value in the environment group; tokens from any other client are then refused.
