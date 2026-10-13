---
id: T-010
title: CI workflows and PR template
phase: 0
area: infra
status: done
owner: agent-t010
claimed_at: 2026-10-13T06:28:01.903Z
branch: task/T-010-ci-workflows-and-pr-template
depends_on: [T-005, T-008]
review: self
claimable_by: agent
size: M
paths: [.github/workflows/**, .github/pull_request_template.md, .github/dependabot.yml]
---

# T-010 — CI workflows and PR template

**Phase** 0 · **Area** infra · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-005, T-008

## Goal

Every PR to the integration branch is checked automatically.

## Scope

- `web.yml`: pnpm install (cached) → `node scripts/tasks.mjs check --local` → turbo lint/typecheck/test/build (affected) with a Postgres 17 service container (`DATABASE_URL` for integration tests).
- `android.yml`: path-filtered (`apps/android/**`, `packages/design-tokens/**`, `packages/i18n/**`, `packages/contracts/**`), JDK 17, Gradle cache, ktlint, detekt, unit tests, `assembleDevDebug`.
- `generated-check.yml`: tokens, icons, i18n, openapi `--check` modes fail on drift.
- Runs on `pull_request` to `feature/**` and `main`, and on push to those branches.
- PR template with: Task ID, summary, how verified, screenshots (UI), checklist from tasks/README.md §5.
- Dependabot for npm, gradle, github-actions (weekly, grouped).

## Acceptance criteria

- [x] A PR with a lint error fails; a clean PR passes.
- [x] Android job is skipped for web-only changes.

## Tests required

- Open a throwaway PR (or use `act`) to show both pass/fail paths; note evidence in completion notes.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `.github/workflows/**`
- `.github/pull_request_template.md`
- `.github/dependabot.yml`

## References

PLAN §17 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| File | Workflow / job (check name) | What it does |
|---|---|---|
| `.github/workflows/web.yml` | `Web` | `pnpm install --frozen-lockfile` → `node scripts/tasks.mjs check --local` → `biome ci .` (whole repo) → `turbo run lint`, `typecheck`, `test`, `build`, each a separate step. Postgres 17 service container; `DATABASE_URL` / `DATABASE_URL_UNPOOLED` = `postgres://postgres:postgres@localhost:5432/cable_billing`. |
| | `Web e2e` | `playwright install --with-deps chromium` (version from apps/web) → `turbo run build --filter=@cb/web` → `pnpm --filter web test:e2e` (`next start` on :3100). Uploads `playwright-report/` + `test-results/` on failure. No `DATABASE_URL` (the smoke test expects `db: not_configured`). |
| `.github/workflows/android.yml` | `Android changes` | dorny/paths-filter: `apps/android/**`, `packages/design-tokens/**`, `packages/i18n/**`, `packages/contracts/**`, `.github/workflows/android.yml`. |
| | `Android` | Runs only if the filter matched (or on manual dispatch). JDK 21 (Temurin), android-actions/setup-android (licences), gradle/actions/setup-gradle (basic cache, wrapper-jar validation), then in `apps/android`: `./gradlew --stacktrace ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`. Uploads `**/build/reports` + `test-results` on failure. |
| `.github/workflows/generated-check.yml` | `Generated files` | `pnpm tokens:build --check`, `pnpm icons:build --check`, `pnpm i18n:check`, `pnpm i18n:build --check`, OpenAPI check (guarded, below), then `pnpm generate` and fail if `git status --porcelain --untracked-files=all` is not empty (prints the diff). |
| `.github/pull_request_template.md` | | Task, summary, how verified, screenshots, notes, and the §3.5/§5 checklist. |
| `.github/dependabot.yml` | | npm (root, pnpm workspace + catalog), gradle (`/apps/android`), github-actions; weekly Monday 06:00 IST, grouped (minor+patch / major; all actions in one), `target-branch: feature/mvp`, cooldown 3 days (7 for actions). |

All three workflows: `pull_request` into `main` / `feature/**`, `push` to `main` / `feature/**`, and
`workflow_dispatch`. `permissions: contents: read` (the filter job adds `pull-requests: read`).
Concurrency group per workflow + PR number (or ref); a newer push cancels the superseded run, except on
`main`. Node from `.nvmrc`, pnpm from `packageManager` via pnpm/action-setup (`cache: true` caches the
pnpm store keyed on the lockfile; corepack is not used). Runners pinned to `ubuntu-24.04`.

**Required checks for branch protection** (feature/mvp and main): `Web`, `Web e2e`, `Generated files`,
`Android`. `Android changes` need not be required. All four always report on a PR: Android's path
filter is a job-level `if:`, and a skipped job counts as passed, whereas a workflow-level `paths:`
filter would leave a required check "Expected — waiting" forever.

**How to add a job / check**

- TS work goes through turbo: a package script `lint` / `typecheck` / `test` / `build` is picked up
  by `Web` automatically (nothing to edit here). A new generator: hang it off the package's `generate`
  script (the catch-all covers it) and, for a clearer error, add its `--check` as a step in
  `generated-check.yml`.
- **T-051:** name the OpenAPI script `openapi:build` in `@cb/contracts` with a `--check` mode; the
  guarded step starts running it as soon as the script exists (until then it logs a notice).
- **DB integration tests (T-020+):** turbo runs in strict env mode, so `DATABASE_URL` reaches a task
  only if that package's `turbo.json` lists it (`test.env` / `passThroughEnv`). The database exists
  and is empty; migrations are the test setup's job.
- A new job: copy the checkout → pnpm → node → `pnpm install --frozen-lockfile` steps (no shared
  composite action: `.github/actions/` is outside this task's paths), give it a `name:` (that is the
  check name), `timeout-minutes`, and add it to branch protection if it must gate merges.
- Pin new actions to a full commit SHA with a `# vX.Y.Z` comment; Dependabot keeps both updated.
- Android release (PLAN §17 "on tag: signed AAB → Play") is T-073's, not here.

**Decisions**

- **`--affected` on pull requests only** (`TURBO_SCM_BASE` = the PR's base SHA, full-history
  checkout with `filter: blob:none`); pushes to `feature/mvp` / `main` run every package, so the
  integration branch is fully verified after each merge. A PR that edits `web.yml` also runs
  everything, so CI changes prove themselves. Dependents are included (a change in `@cb/i18n` runs
  `@cb/web` too; checked with `turbo --dry=json`). Biome always runs on the whole repo.
- **Board commits don't trigger push runs**: `paths-ignore: [tasks/**, docs/**]` on `push` for Web and
  Generated files (claims/blocks from `scripts/tasks.mjs` push straight to feature/mvp; the repo is
  private, so runner minutes count). Pull requests are never path-filtered.
- **Separate `Web e2e` job** (parallel with `Web`, clearer check, room for T-088 to shard) rather than
  extra steps in `Web`.
- **Gradle cache:** `cache-provider: basic` (MIT, plain Actions cache) instead of the default
  "enhanced" provider, which is a commercial component with its own licence terms. Pushes write the
  cache, PRs only read it (PRs can read their base branch's cache).
- **Android SDK:** setup-android installs cmdline-tools and accepts licences; AGP downloads
  `platforms;android-37` / build-tools itself, so SDK levels live only in `build.gradle.kts`.
- **Action versions** (SHAs read with `git ls-remote` from each action's repo; commit dates checked;
  releases younger than ~2 weeks avoided): actions/checkout v7.0.1, pnpm/action-setup v6.1.0 (the
  release that added pnpm 12), actions/setup-node v7.0.0 (v7.1.0 was 6 days old),
  actions/setup-java v6.0.1, android-actions/setup-android v4.0.4, gradle/actions/setup-gradle v6.4.0,
  dorny/paths-filter v4.0.3, actions/upload-artifact v7.0.1 (v7.0.2 was 6 days old). The
  `postgres:17` service image is a tag, not a digest.
- Dependabot cooldown because pnpm 12 rejects packages published < 1 day ago (HANDOFF §6), which would
  make a same-day Dependabot PR fail `pnpm install --frozen-lockfile`.

**Deviations**

- **JDK 21, not 17**, for the Android job: Robolectric runs the unit tests at API 36 and refuses Java
  < 21 (T-008 notes). No separate JDK 17 assemble-only job (it would double Gradle minutes on a
  private repo); T-008 verified a JDK 17 build of `ktlintCheck detekt lint assembleDevDebug` by hand,
  and `apps/android/README.md` still documents "JDK 17+ to build".
- `android lint` and `:detekt-rules:test` added to the task's list (T-008's full check).
- Workflow file is `generated-check.yml` (task) rather than PLAN §17's `tokens-check.yml`; it covers
  tokens, icons, i18n and (later) OpenAPI.

**Follow-ups (no task files created)**

- Coordinator: protect `feature/mvp` and `main` with the four required checks above (tasks/README.md
  §8). Board commits are direct pushes, so the agents' account needs a bypass.
- Merging this PR will itself trigger a full push run on feature/mvp (the first non-`--affected` run
  of `Web` in CI); worth a glance.
- PLAN §17 "Playwright against the preview URL": `playwright.config.ts` already honours
  `E2E_BASE_URL`; wiring a Vercel preview deployment status into CI waits for H-01 (Vercel project).
- `pnpm/action-setup` logs a harmless "Unable to reserve cache … another job may be creating this
  cache" when several jobs finish at once on a cold cache.

**Verification**

- `actionlint` 1.7.12 (release binary, checksum verified) with shellcheck 0.11.0: 0 findings on all
  three workflows. `dependabot.yml` validated against the SchemaStore `dependabot-2.0` JSON schema: 0
  errors.
- Local (Node v24.21.0, pnpm 12.11.2): `pnpm install --frozen-lockfile`, `pnpm lint` (`biome ci .`
  also clean), `pnpm typecheck` 9/9, `pnpm test` 9/9, `pnpm build` 9/9, `tokens:build --check`,
  `icons:build --check`, `i18n:check`, `i18n:build --check`, `pnpm generate` (no drift),
  `node scripts/tasks.mjs check --local`: all pass. No Gradle run locally (CI ran it; T-009 was using
  the machine).
- **Pass path** (this PR #10, first commit `be9c21f`): Web + Web e2e
  https://github.com/anmol098/cable-billing-v2/actions/runs/38357551544 (e2e: 5 Playwright tests
  passed against `next start`); Generated files
  https://github.com/anmol098/cable-billing-v2/actions/runs/38357551546; **Android ran** (the PR touches
  `android.yml`): https://github.com/anmol098/cable-billing-v2/actions/runs/38357551530 — `BUILD
  SUCCESSFUL in 7m 8s` on a cold cache, 112 tasks (ktlintCheck, detekt, lint, testDevDebugUnitTest,
  assembleDevDebug, :detekt-rules:test) on JDK 21. That first run used `--affected` on a PR that
  touched no package, so turbo ran 0 tasks; the final head runs every package because `web.yml` now
  forces a full run when it changes (see the PR's latest checks).
- **Fail path** (throwaway draft PR #11, closed unmerged; branch `task/T-010-ci-failcheck` = this
  branch + a `value: any` in `apps/web/src/lib/health.ts`): `Web` failed at "Lint (Biome, whole repo)"
  with `apps/web/src/lib/health.ts:42:41 lint/suspicious/noExplicitAny` shown as an annotation —
  https://github.com/anmol098/cable-billing-v2/actions/runs/38357625338/job/115164082315.
- **Android skipped for a web-only change** (same PR #11): `Android changes` → android=false, `Android`
  job skipped, run conclusion success —
  https://github.com/anmol098/cable-billing-v2/actions/runs/38357625362. Because #11's diff against
  feature/mvp necessarily contained `android.yml` itself, that branch also dropped the filter's
  self-pattern (the only difference from this PR's filter), so the filter saw only `apps/web` and
  `.github` files.

## Board log

- 2026-10-13T06:28:01.903Z claimed by agent-t010
- 2026-10-13T06:46:21.767Z completed on task/T-010-ci-workflows-and-pr-template
