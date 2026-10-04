# ADR-071 — Controlled release: migrate, then deploy (Phase 0)
**Decided by:** Julian ("replace push → failed preflight → manual redeploy")

Before: Render auto-deployed every push; when a commit shipped a migration, preflight (correctly) refused to
start until the GitHub `migrate` workflow was approved, then a manual "Deploy latest commit" was required
(happened 3× on 2026-10-04).

Now: Render Auto-Deploy = Off (dashboard, 2026-10-04; blueprint `autoDeploy: false`). `.github/workflows/release.yml`
runs on every push to main: `detect` diffs `migrations/` vs the previous commit → if changed, `migrate` runs
under the `production` environment (Julian approves once) → `deploy` POSTs the Render deploy hook and
waits for `/health` to report the released SHA. The deploy job cannot run if migration failed. Preflight
remains the last line of defense. Regression: `test/unit/release-gate.test.ts` (4) + `deploy-config.test.ts`.

Setup (one-time, human): GitHub repo secret `RENDER_DEPLOY_HOOK` = the hook URL from Render → Settings → Deploy Hook.
