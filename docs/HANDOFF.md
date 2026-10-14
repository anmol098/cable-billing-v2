# Handoff: current state of the build

| | |
|---|---|
| **Date** | 2026-10-14 |
| **State** | 67 of 91 tasks done. Phases 0–4 are essentially built: billing, payments, statements, reports, import, subscriptions, the admin console, the audit log and the whole Android collect/handover path are merged (see §2). In flight at the time of writing: T-045a, T-082, T-086b, T-088. What's left is mostly blocked on people: accounts (H-01), the legacy dump (H-06) and product decisions (§8). |
| **Environment** | A cloud container with full network access (Android SDK, Google Maven, Maven Central, Gradle plugin portal all reachable). Setup steps are in §3. |

Read this first, then `CLAUDE.md` and `tasks/README.md`.

---

## 1. Where things are

| What | Where |
|---|---|
| Integration branch (holds the task board) | `feature/mvp`. Every task PR merges here. |
| Source of truth | `docs/BRD.md`, `docs/PRD.md` |
| Plan + decisions (D-01 … D-25) | `docs/IMPLEMENTATION_PLAN.md` |
| Task board + agent guide | `tasks/` and `tasks/README.md` |
| Board CLI | `node scripts/tasks.mjs help` |
| Repo conventions (auto-loaded by Claude Code) | `CLAUDE.md` |
| Environments runbook (H-01 walkthrough) | `docs/runbooks/environments.md` |
| Android build notes | `apps/android/README.md` |
| CI | `.github/workflows/{web,android,generated-check}.yml`. Required-check names: `Web`, `Web e2e`, `Generated files`, `Android` |
| Merged PRs so far | Phase 0: #1 T-001 · #2 T-004 · #3 T-002 · #5 T-003 · #6 T-005 · #7 T-011 · #8 T-006 · #9 T-008 · #10 T-010 · #12 T-007 · #13 T-009 · #15 CI fix<br>Phase 1: #16 T-024 · #17 T-020 · #18 T-041 · #19 T-067 · #20 T-051 · #21 T-042 · #22 T-040 · #23 T-021 · #24 test fix · #25 T-020a · #26 T-063 · #27 T-022 · #28 T-025 · #29 handoff<br>Phase 1–3 (continued): #30 T-023 · #31 T-064 · #32 T-046 · #33 T-043 · #34 T-068 · #35 T-026 · #36 T-044 · #37/#39/#41/#46 test fixes · #38 T-036 · #40 T-065 · #42 T-050 · #43 T-029 · #44 T-028 · #45 T-027 · #47 T-052 · #48 T-066 · #49 T-087 · #50 T-090<br>Wave 3: #51 T-062 · #52 T-033 · #53 handoff · #54 T-030 · #55 T-071 · #56 T-061 · #57 T-047 · #58 T-032 · #59 T-034 · #60 T-048 · #61 T-049 · #62 T-070 · #63 T-069 · #64 T-031 · #65 T-085 · #66 T-080 · #67 T-060 · #68 T-045 · #69/#70/#76/#77 test fixes · #71 T-083 · #72 T-035 · #73 T-084 · #74 T-081 · #75 T-086 · #78 T-072 · #79 T-096 · #80 T-087a · #81 T-091 |

**Verified on `feature/mvp`** (Node 24.21.0, pnpm 12.11.2, JDK 21, Postgres 17): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff), the tokens / icons / i18n `--check` modes, `node scripts/tasks.mjs check --local`, the Playwright e2e suite, and in `apps/android` `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`. CI runs the same on every PR.

---

## 2. Board status

| Status | Tasks |
|---|---|
| **Done (Phase 0)** | T-001 … T-011 |
| **Done (Phases 1–5)** | T-020 … T-036 (data, core, auth, sign-up, shell, settings, plans, team, customers, connections, audit, seed) · T-040 … T-052 (billing calc/run/UI, allocation, netting, jobs, adjustments, payments, statements, receipt links, mobile contract, invariants) · T-060 … T-072 (mobile API, handover, the whole Android app incl. durability tests) · T-080 … T-087a (registers, reports, home, import, Razorpay + read-only mode, admin console, public pages, payload) · T-090 · T-091 (draft; column names wait for the dump) · T-096 |
| **In flight** | T-045a Owner back-dated new connection · T-082 CSV exports · T-086b admin TOTP per session · T-088 e2e journeys |
| **Ready for an agent** | T-086a sync metrics · T-086c platform-read allow-list audit · T-087b language switch label/font · T-095 load testing (run it on a quiet machine or CI, not a shared container) · T-096a health DB ping + cron check-ins |
| **Waiting on a product decision** | T-031a apply a plan's new rent to existing connections · T-062a what "flag an unsubmitted handover" should do (see §8) |
| **Waiting on people** | T-073 (needs H-01 Play Console) · T-092 / T-093 / T-094 migration (need the legacy dump, H-06) |
| **Human** | H-01 accounts + secrets · H-02 domain / accent / applicationId · H-03 Hindi review · H-04 usability round · H-05 device + printer matrix · H-06 migration sign-off · H-07 finance sign-off · H-08 pilot · H-09 cutover · H-10 GSTIN |

Run `node scripts/tasks.mjs board` for the live view.

**Acceptance gaps that need a human, an emulator or hardware** (this container has no `/dev/kvm`, Bluetooth or Neon access):
- T-008: the app has never been launched on an API 26 or API 35+ emulator.
- T-009 / T-063 / T-067: components, login screen (123/ABC keyboard switch, Play Store link, Keystore on API 26 and 35+) and voice (Google TTS with/without the Hindi voice, no-engine phone) are unchecked on a real phone.
- T-068: test print on a real 58 mm ESC/POS printer.
- T-065 / T-066: search, collect and "kill the app right after Save" on a real phone (force-stop, reboot, power cut, Doze/OEM battery savers delaying the push, 360×640 screens).
- T-087: Lighthouse mobile ≥ 90 is not reliably met (86–99); the cause is app-wide (Sentry browser SDK, fonts) and is tracked in T-087a.
- T-090: the tools have never seen the real legacy dump (every legacy column apart from `op_id`, `isReceipt`, `isDeleted` is a guess in `tools/migration/src/config.ts`).
- T-027 / T-029 / T-087: nobody has looked at `/signup`, `/verify/<token>`, the shell and the public pages at 360 px in Hindi.
- T-020a: the `cb_app` role SQL and `\password` on Neon, and the pooled endpoint accepting it.
- T-072: the shared durability suite runs on Robolectric on every PR, but never on a device. `docs/testing/android-field-uat.md` has a ready-to-paste nightly emulator workflow (needs adding to CI) and the field script for H-04/H-05. A device run should also confirm the SQLite journal mode: WAL with `synchronous=NORMAL` could lose the last payments on a power cut.
- T-087a: pages are 50–120 KiB lighter, but Lighthouse mobile ≥ 90 was not shown (scores swung 20–40 points on the loaded container). Re-measure on a Vercel preview (H-01). The language-switch label and the Devanagari font on English pages are T-087b.
- T-096: backup and restore were proven only on local Postgres with fake data (1.17 M rows: 18 s backup, 44 s restore + verify). The Neon drill, the bucket, the Sentry alerts (`sentry-alerts.mjs --apply`) and the uptime check need H-01. The nightly jobs only start once `BACKUP_ENABLED` / `RESTORE_DRILL_ENABLED` are set and `backup.yml` is on `main`.
- T-091: the mapping names every legacy table but only three legacy columns are known; the rest wait for the dump (run the T-090 profiler and query Q0, then §12 of `docs/migration/mapping.md`).
- T-067 / T-073: set `bundle { language { enableSplit = false } }` before the first Play upload, or Hindi strings can be missing on English-language phones.

---

## 3. Setting up a fresh container

```bash
# 1. Clone and switch to the integration branch
git clone https://github.com/anmol098/cable-billing-v2 && cd cable-billing-v2
git switch feature/mvp

# 2. Node 24 + pnpm 12. Corepack's bundled shim can't run pnpm 12 (it looks for bin/pnpm.cjs),
#    so install pnpm globally with npm instead of `corepack enable`.
nvm install 24 && nvm use 24
npm i -g pnpm@12.11.2
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build

# 3. Android SDK (JDK 21 needed for the Robolectric unit tests; building alone works on JDK 17+)
mkdir -p /opt/android-sdk/cmdline-tools && cd /tmp
curl -sSLO https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
unzip -q commandlinetools-linux-16111833_latest.zip -d /opt/android-sdk/cmdline-tools
mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest
export ANDROID_HOME=/opt/android-sdk
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.1.0"
# AGP downloads compileSdk 37 and build-tools 36.0.0 itself on the first build.
cd apps/android && ./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug
```

```bash
# 4. PostgreSQL 17 for the DB integration tests (Docker has no daemon in this container).
install -d /usr/share/postgresql-common/pgdg
curl -sSf -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
. /etc/os-release
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt-get update && apt-get install -y postgresql-17
# Make 17 the cluster on 5432 (move any other cluster off it), then match CI's credentials:
pg_ctlcluster 17 main start
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\" -c 'CREATE DATABASE cable_billing;'"
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/cable_billing (same as CI)
```

**Environment notes from Phase 0 and 1:**
- **The container can reboot while idle.** The disk survives (SDK, Node, pnpm, Postgres data) but services don't: after a reboot run `pg_ctlcluster 17 main start` before DB tests (symptom: `ECONNREFUSED 127.0.0.1:5432`).
- Don't run `db:test:clean` while other agents run DB tests: it drops their template databases.
- GitHub's check-run summary sometimes lags by many minutes. Before calling a run stuck, list the workflow run's jobs (`mcp__github__actions_list` → `list_workflow_jobs`): it shows the real step status. Agents' sense of elapsed time is unreliable; check `date -u`.
- The Claude Code Bash tool snapshots its shell, so a toolchain on `PATH` from `~/.bashrc` may not be picked up. Prefix commands with `export PATH=<node24>/bin:$PATH ANDROID_HOME=/opt/android-sdk`. Worktree sandboxes may also refuse `source`, compound git commands and URLs containing "github": run git commands on their own.
- **Maven Central answers HTTP 429 to Gradle from the cloud egress** (curl gets 200). Fix it locally, never in the repo: a Gradle init script in `~/.gradle/init.d/` that rewrites `https://repo.maven.apache.org/maven2` to Google's mirror `https://maven-central.storage-download.googleapis.com/maven2/` and sets the Test system property `robolectric.dependency.repo.url` to the same mirror. GitHub-hosted CI runners don't need it.
- Playwright: if the pinned `@playwright/test` doesn't match the pre-installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the installed `chrome` binary. Parallel agents should use a distinct `E2E_PORT`.
- No `/dev/kvm`: no emulator. Compose UI tests run on Robolectric.

---

## 4. Known blockers

| Blocker | Effect | Fix |
|---|---|---|
| H-01 (accounts and secrets) | **Production builds fail on purpose** until every `[prod]` variable in `apps/web/.env.example` is set (T-011), including live Razorpay keys and a verified email domain. Previews need only `DATABASE_URL` + `BETTER_AUTH_SECRET` at runtime. | Product owner, following `docs/runbooks/environments.md`. |
| H-02 (domain, accent colour, applicationId) | Android staging/prod API URLs are `*.cablebilling.example` placeholders; no launcher icon or favicon yet; email domain undecided. | Product owner. |
| Emulator checks (T-008, T-009) | See §2. | A human, or a later emulator CI job. |
| A shared, overloaded container | With 4–5 agents building at once (load average 20–60 on 4 CPUs), Vitest timeouts and wall-clock checks fail in packages a PR never touched. | Verify with `TURBO_FORCE=1 pnpm test --concurrency=1`; re-run a failing file alone before calling it real; keep at most 4 agents. #76 and #77 raised two budgets that were genuinely too tight. |
| Occasional network blips in CI | One Android run failed fetching the KSP plugin; a fresh run passed. | Re-run once. A second failure is real. |

---

## 5. Recommended next wave

Follow `node scripts/tasks.mjs next`. What is left for agents is small; the big remaining items need people.

| Do | Why |
|---|---|
| Merge the in-flight PRs (T-045a, T-082, T-086b, T-088) | T-045a and T-086b are `review: required`: review the diff yourself or with a reviewer agent before merging (T-086's review found a real append-only gap). |
| T-086c, T-096a, T-087b, T-086a | Small hardening follow-ups from the reviews. |
| Get answers to §8 | Unblocks T-031a and T-062a, and several defaults already built in. |
| H-01, then T-073, then T-095 on real infrastructure | Production builds, Play upload, backups, alerts and a meaningful load test all need the accounts. |
| H-06: the legacy dump | Unblocks finishing T-091 and the whole migration chain T-092 → T-093 → T-094 → H-09 cutover. |

The user's standing instruction in this session was "keep merging": the coordinator verified each PR locally (rebase onto the latest `feature/mvp`, full checks incl. DB tests, Gradle for Android), reviewed `review: required` PRs, and merged once CI was green. Ask the user again in a new session.

---

## 6. Lessons from the first wave (give these to every agent)

1. **Agent worktrees can start on an old commit.** Always `git fetch origin feature/mvp` and **create the task branch after claiming**, from `origin/feature/mvp`.
2. **Node 24 is required** (`engines` is strict). In the old container it wasn't the default and had to be put on `PATH` explicitly.
3. **pnpm 12 refuses packages published less than a day ago.** Pick the previous version; don't add exceptions. It also needs explicit `allowBuilds` entries for install scripts (`esbuild: false` is already set in `pnpm-workspace.yaml`).
4. **TypeScript 7 (native compiler)** is the pinned version. Next.js 16.4 works with it (checked in T-001).
5. **Library packages are source-only** (`exports` → `src/index.ts`). apps/web must list `@cb/*` in `transpilePackages`. Node scripts run with `tsx`.
6. **Parallel PRs conflict in `package.json` scripts and `pnpm-workspace.yaml`.** Keep both sides. For the lockfile, take `feature/mvp`'s version and re-run `pnpm install`. T-002 hit this and resolved it as `tasks/README.md` §6 says.
7. Turbo 2.11 auto-creates an `AGENTS.md`. It's disabled with `"agentGuidance": false` in `turbo.json`; don't re-enable it.
8. `.claude/worktrees/`, `.claude/settings.local.json` and `.turbo/` are git-ignored. A stop hook complaining about them in an old checkout is fixed by updating to `feature/mvp`.
9. Small follow-up noted by T-002: `@cb/i18n` pins its own `tsx` version and could switch to `"tsx": "catalog:"`. Do it in any later PR that touches `packages/i18n/package.json`.
10. **Phase 0 wave:** agents were not allowed to merge their own PRs (auto-mode classifier). The coordinator re-verified each PR locally (and the Android build), rebased it when `feature/mvp` had moved, and squash-merged it with the user's go-ahead.
11. **Android tests need JDK 21** (Robolectric at API 36). compileSdk 37, targetSdk 36 (Play requirement since Aug 2026).
12. **Give long property tests an explicit timeout** (`}, 60_000);`). Vitest's default is 5 s and a busy machine blows it (T-042 hit this). Avoid tests that depend on small real-time gaps (a 50 ms debounce test was flaky until #24 typed with `delay: null`).
13. **Two parallel PRs appending to the same index file** (`packages/domain/src/index.ts`, `packages/db/src/schema/index.ts`, `packages/core/src/index.ts`): on rebase keep both lines.
14. **Migrations:** generate yours last, after the final rebase. Custom SQL (triggers, functions, EXCLUDE constraints, extensions) goes in a separate custom migration (pattern from T-021/T-022).
15. **Generated files conflict on almost every rebase** (`apps/web/messages/{en,hi}.json`, `strings_generated.xml`, `openapi.json`, `pnpm-lock.yaml`): take `feature/mvp`'s side and run `pnpm install && pnpm generate`. **`packages/i18n/glossary.md`**: every task appends its own section, so keep both.
16. **A container restart stops Postgres** (`ECONNREFUSED`): `pg_ctlcluster 17 main start`. An API rate limit can also stop every running agent at once; resume each one with a message ("continue where you stopped; check `git status` first") once the limit resets. Their uncommitted work survives in the agent worktrees.
17. **Flaky tests seen so far, all fixed:** a 50 ms debounce (#24), a ~1% request-id assertion (#37), web/ui timeouts under load (#39, #41), and `PrinterSettingsTest` opening a second DataStore before the first scope finished (#46: `cancelAndJoin`, not `cancel`). Fix the root cause; never skip a test.
18. **GitHub check summaries lag.** Read the workflow run's jobs (`actions_list` → `list_workflow_jobs`) for the real status. Android CI takes ~12 min and only runs the full build when Android-relevant paths (incl. i18n and icons) change.

19. **Never run `corepack enable`** in this container, even though `CLAUDE.md`'s Commands section mentions it: it replaces the working global `pnpm` with a corepack shim that can't find `bin/pnpm.cjs` and breaks pnpm for every agent at once. Fix: `ln -sfn ../lib/node_modules/pnpm/pnpm pnpm` (and `pnpx`) in `/opt/nvm/versions/node/v24.21.0/bin`. Put the warning in every agent prompt.
20. **The audit viewer registry (T-035) catches every new audit action.** `packages/core/src/audit-query/actions.test.ts` fails until a new action (including a service's default action name) has an entry in `AUDIT_ACTIONS` and an en/hi sentence + filter label in `audit.json`; a service that always calls `audit.skip` goes in `NEVER_THE_DEFAULT_ACTION`. Tell every agent that adds a service.
21. **Board commits land on `feature/mvp`** (`board: claim T-xxx`). They move the base under open PRs; that is expected, not someone else's work.
22. **Removing an agent's worktree means it can't be resumed.** Only remove worktrees of agents that have sent their final report; to follow up on a finished agent's PR, start a new agent on its branch.
23. **Review `review: required` PRs with a separate reviewer agent** (read-only, adversarial, ranked findings) and send the fixes back as a new agent. On T-086 this found that an ended support grant could be reopened at the database level.
24. **Acceptance criteria that need a device, real accounts or the dump stay unticked**, with the reason in the completion notes; the task can still be completed and merged. §2 lists every such gap.

**Interfaces delivered so far** (details in each task file's *Completion notes*):

- **Tokens (T-002):** `import "@cb/ui/theme.css"` gives token-only Tailwind v4 utilities (`bg-bg`, `text-cash`, `text-amount`, `border-hairline`, `rounded-md`, `min-h-touch-min`, `font-numeric` …). Android: `com.cablebilling.designsystem.generated.Tokens`. Regenerate with `pnpm tokens:build`.
- **Icons (T-003):** `<Icon name="cash" />` from `@cb/ui`; Android `R.drawable.ic_cb_<name>` (tint from Compose). Add a meaning to `packages/design-tokens/icons.json` and run `pnpm icons:build`.
- **Web app (T-005, T-011):** `apps/web` is `@cb/web` (`pnpm --filter web …`). Env via `import { serverEnv, clientEnv, requireServerEnv, baseUrls } from "@/env"`; adding a variable touches the schema, `.env.example`, `apps/web/turbo.json` and the runbook (tests catch drift). Next 16 uses `src/proxy.ts` instead of `middleware.ts`: T-026's owned path must follow.
- **Web UI (T-006, T-007):** primitives and composites from `@cb/ui` take all words as props (no next-intl inside `packages/ui`). `/dev/ui` shows everything (404 in production). T-029 must mount `ToastProvider` in the app shell and reserve space for `PageHeader`'s pinned phone action.
- **Android (T-008, T-009):** modules `:app`, `:core:designsystem`, `:detekt-rules`. Wrap screens in `CableTheme {}`; raw `.dp`/`.sp`/`Color(` outside `core/designsystem` fail detekt. Components live in `com.cablebilling.designsystem.component` (BigButton, MethodButton, NumberPad, AmountDisplay, StatusChip, CustomerRow, SyncBanner, ConfirmCard, ReceiptActionTile, SpeakButton). Strings: add a `mobile_<feature>` i18n namespace. Debug builds have a "Components (test)" catalogue launcher. AGP 9 has Kotlin built in (don't apply `kotlin-android`); ktlint runs via its CLI and detekt as one root task.
- **CI (T-010):** T-051 must name its script `openapi:build` with a `--check` mode; packages whose tests need `DATABASE_URL` must list it in their `turbo.json`.
- **DB (T-020, T-020a, T-021, T-022):** `createDb()` → `withTenant(operatorId, tx => …)` / `withPlatform(…)`; no raw handle. Schema helpers `primaryId`, `operatorIdColumn`, `tenantKey`, `tenantPolicies`, `appendOnlyTriggerSql`; harness `@cb/db/testing`; `nextCounter`; `checkRuntimeRole`. Conventions and the platform-access table are in `packages/db/README.md`.
- **Domain (T-024, T-040, T-041, T-042):** `@cb/domain` — `Paise` + checked arithmetic, `formatINR`, `parseRupeesInput`, `BusinessDate`/`Period`, `Result`; `isBillable`/`buildInvoice`; `allocate`/`applyCredit`/`reverse`/`checkLedger`; `planChangeForPeriod`/`midMonthStartForPeriod`. Pure, no clock.
- **Core (T-025):** `defineService({ name, capability, input, run })`, `resolveTenantContext`, `CAPABILITIES`/`can`, `assertWritable`, audit + logger, isolation cases `<feature>.isolation.ts` (coverage test enforces them).
- **Contract (T-051):** `@cb/contracts` `ENDPOINTS`, `ERROR_CODES`, `openapi.json` (`openapi:build --check`), `fixtures/`.
- **Android (T-063, T-067):** `MobileApi`/`AuthApi` + `apiCall` → `ApiResult`; `SessionStore`/`AuthRepository`; generated DTOs (drift-checked); `VoiceLines`, `SpeakOnShow`, `SpokenAmount`.
- **Web auth + tenants (T-026, T-027):** Better Auth in `apps/web/src/lib/auth/server.ts` (`getRateLimiter()`, `getSignupService()`); `provisionTenant(runtime, input)` in `@cb/core` is idempotent on the caller's `operatorId` and is what T-086 (admin) and T-092 (migration) call.
- **Mobile auth (T-028):** `withMobileAuth(ENDPOINTS.x, getMobileDeps, handler)` in `apps/web/src/lib/mobile/http.ts` does the version gate, bearer check and `TenantContext`; `reply.ok/error/serviceError`; `revokeMobileRefreshTokens(tx, …)` for T-032 (deactivate, password reset).
- **Billing, payments, jobs (T-043, T-044, T-046, T-052):** see the task files; platform jobs fan out per tenant and fail loudly (Sentry + admin email). `invariants.check` runs nightly and fails the job on a breach.
- **Receipts (T-050):** `createReceiptLink` / `revokeReceiptLinks` services, `receiptLinkUrl(baseUrls().receipt, token)`; tokens are stored only as SHA-256.
- **Web shell (T-029):** `NAV` in `apps/web/src/lib/nav.ts`; feature pages overwrite their placeholder `page.tsx` and use `ShellPageHeader` + `PAGE_ACTION_CLEARANCE`. The route → owning task table is in T-029's completion notes.
- **Android collect path (T-064 … T-068):** Room v1 (`CableMigrations.ALL`, never destructive); `PaymentRepository.save` commits before "Saved"; `PaymentSync` pushes only the signed-in lineman's payments, 50 per batch, idempotent; `FakePaymentServer` for tests; `ReceiptPrinter.print`.
- **i18n (T-004):** per-namespace files in `packages/i18n/messages/{en,hi}/<ns>.json`, with machine-drafted Hindi listed in `_review`. Web output is `apps/web/messages/{en,hi}.json` (next-intl). Android output is `strings_generated.xml` with `R.string.<ns>_<key>` (only `common` + `mobile_*`). Commands: `pnpm i18n:check`, `pnpm --filter @cb/i18n i18n:build [--check]`.

---

## 7. How the previous sessions orchestrated agents

- One Claude Code subagent per task, each with **worktree isolation**, running in the background, with its own `AGENT_ID` (`agent-t005`, …).
- Each agent: claims the task, branches from `origin/feature/mvp`, implements, verifies, fills in completion notes, runs `complete`, rebases, pushes, opens a PR into `feature/mvp` (GitHub MCP tools) and stops. In Phase 0 the coordinator then re-verified and squash-merged `review: self` PRs (see §6 item 10). `review: required` PRs wait for a human.
- The coordinator only assigns tasks (to avoid two agents asking for the same one), checks `feature/mvp` stays green after each merge, and launches the next wave as dependencies complete.

### Worker prompt template

Replace `{ID}`, `{TITLE}`, `{AGENT}`, `{BRANCH}` (the branch printed by `claim`) and `{EXTRA}` (task-specific notes).

```text
You are a worker agent on the Cable Billing monorepo (GitHub: anmol098/cable-billing-v2).
Your assigned task is {ID} ({TITLE}). Do only this task.

Setup
- You may be in an isolated worktree starting on an OLD commit. Run `git fetch origin feature/mvp` first.
  Read CLAUDE.md, tasks/README.md (whole guide), docs/HANDOFF.md §6, your task file tasks/{ID}-*.md,
  the completion notes of every task in its depends_on, and the referenced sections of docs/IMPLEMENTATION_PLAN.md.
- Use Node 24 (check `node --version`). Use `export AGENT_ID={AGENT}` for board commands.

Workflow (tasks/README.md §3)
1. `node scripts/tasks.mjs claim {ID}`. Stop and report if the exit code isn't 0.
2. AFTER claiming: `git fetch origin feature/mvp && git switch -c {BRANCH} origin/feature/mvp`.
3. Implement the Scope inside the owned paths plus the §6 shared-file rules. Follow the CLAUDE.md conventions.
   {EXTRA}
4. Verify the definition of done (§3.5): pnpm install/lint/typecheck/test/build, generators' --check modes,
   `node scripts/tasks.mjs check --local`. For Android tasks, also ./gradlew ktlintCheck detekt testDevDebugUnitTest assembleDevDebug.
   Report real results only.
5. Fill in Completion notes (interfaces, decisions, deviations, verification). Tick the met acceptance criteria.
   Run `node scripts/tasks.mjs complete {ID}`.
6. Commit messages end with:
     Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
     Claude-Session: <this session's URL>
   Rebase on origin/feature/mvp (lockfile: take theirs + pnpm install; generated files: regenerate), re-verify,
   `git push -u origin {BRANCH}` (--force-with-lease only on your own branch). Never push to other branches.
7. Open a PR into feature/mvp titled "{ID}: {TITLE}" with summary, verification and notes for later tasks.
   End the body with the Claude Code attribution footer.
8. Do NOT merge. Make sure the PR is rebased on the latest origin/feature/mvp, verified and CI is green, then stop
   and report the PR link. The coordinator merges review: self PRs; review: required PRs wait for a human.
If blocked: `node scripts/tasks.mjs block {ID} --reason "..."` and report. Never fake results.
Report back: PR URL, head SHA, interfaces for later agents, deviations, problems.
```

---

## 8. Open items for the product owner

**Setup and checks**
- **Device checks:** see the acceptance gaps in §2 (emulator/phone, printer, Neon role).
- **Branch protection:** require the CI checks `Web`, `Web e2e`, `Generated files`, `Android` on `feature/mvp` and `main`.
- **H-01:** accounts and secrets (Vercel Pro, Neon, Sentry, Resend, Upstash, Turnstile, Razorpay, Play Console). Production builds fail on purpose until these are set. Region is Singapore (Neon has no Mumbai). The `cb_app` runtime role steps are in `docs/runbooks/environments.md` §4.12.
- **H-02:** domain, brand accent colour, final Android applicationId (currently `com.cablebilling.lineman`), launcher icon and favicon. Also consider a darker `border` token (#E5E5E5 is ~1.3:1 on white) and a `scrim` token for see-through dialog backdrops.
- **H-03 Hindi review:** every namespace's `_review` list, plus Hindi that lives in code: month names (`packages/domain/src/time/labels.ts`) and spoken number words (`SpokenAmount` in the Android voice package). Key choices: Credit = "एडवांस", Sent to office = "ऑफिस पहुँच गया", "पैसे फ़ोन में सेव हो गए".
- **H-10:** GSTIN and tax details for the ₹400 + GST subscription invoices.
- Open questions Q-02 and Q-04 to Q-12 in `docs/IMPLEMENTATION_PLAN.md` §20.

**Business-rule questions raised in Phase 1** (current default in brackets; each task file's completion notes have details)
- *Allocation (T-041):* Q-A does a debit adjustment hit the ledger on creation or only via the next invoice's charges [only via the invoice] · Q-B apply credit immediately after a reversal/credit adjustment, or only at the next invoice [next invoice] · Q-C "oldest" credit by field `posted_at` or server `recorded_at` [recommend `posted_at`] · Q-D opening-balance invoice before a regular one in the same period [by id] · Q-E reversing a credit adjustment [no flow].
- *Plan changes (T-042):* manual discounts survive a later plan change [yes] · re-running a period after a 1st-of-month start can double-charge (run should skip assignments with a `mid_month_start` adjustment) · a late/missed run must use the rental in force · ₹0 → paid upgrade in the same month [starts next month] · default `mid_month_start_policy` [`start_next_month`, set in T-021].
- *Billing (T-040):* reactivation on the 1st counts as active? [no] · later-period adjustment onto a missed-run invoice? · create ₹0 invoices or skip? · the run and the D-18 mid-month hook must not both charge (T-044/T-045).
- *Schema (T-021, T-022):* 2FA for owners/staff? · cleanup of expired sessions/tokens (Q-06) · same-day VC reuse [rejected; next day] · block deactivating a customer with open assignments? [left to services] · Devanagari trigram search ranking needs checking on real data.
- *Authz (T-025):* linemen may correct a customer's phone [yes, separate capability] · web counter payments in read-only mode [allowed per D-13] · handovers in read-only mode [lineman submit allowed, office accept/return blocked] · system context for cron jobs [proposal in T-025 notes].
- *Mobile (T-051, T-063):* rename `/payments:batch` → `/payments/batch` before T-061? · what "Call office" dials on a never-signed-in phone [empty dialer] · T-028: short grace window for the previous refresh token [5 min, once].

**Questions raised in the second Phase 1–3 wave** (default in brackets)
- *Deactivated lineman's queued payments (T-028, T-046, T-066):* [they stay on the phone, held]. Proposal in T-066's notes: the owner releases them from the web, the phone then sends them under the current lineman's sign-in with the original `collector_id`, posted as `posted_needs_review`. Needs a decision before T-061.
- *Receipt links (T-050):* a new link on every share, older links keep working, max 20 live links per receipt [no reuse, because only the token's hash is stored]. A WhatsApp link preview counts as one view.
- *Sign-up (T-027):* re-typing the password on the confirm page (check in H-04) · operator `default_language` follows the owner's sign-up language? [stays `hi`] · `office_phone` defaults to the owner's mobile [yes] · Turnstile fails closed, so a Cloudflare outage stops new sign-ups [yes] · `/login` has no "Create account" link yet (T-026's page).
- *Shell (T-029):* Staff see the read-only banner but not the grace warning (PLAN §11.9 says Owner only) · Owner-only pages: Undo payment, Bill changes, Download data, Team, Subscription, Audit.
- *Invariants (T-052):* a breach marks the nightly job "failed" so the existing alert fires · `invariant_checks` has no retention yet (Q-06).
- *Public pages (T-087):* privacy policy and terms are drafts and need legal review (entity, grievance contact, DPDP rights, liability, governing law, refund policy, retention) · `SUPPORT_EMAIL` is now required for production builds (`SUPPORT_PHONE` optional) · confirm "No card needed to start", "UPI Autopay or card", "Bills are made on the 1st".
**Questions raised in the third wave** (default in brackets)
- *Platform admin (T-086):* should support access need the Owner's approval, and can the Owner end it? [admin opens it with a reason, 15–120 min, any admin may end it] · should the support view show more (e.g. one customer's account)? [no payments, balances, names or phones] · how to correct a mistyped offline subscription payment (records are append-only, no reversal flow yet), and do they need a GST invoice (H-10)? · switching an operator off/on (PRD §3) and migration batch reports are not built.
- *Reports (T-081):* should the collections report show linemen only? [includes counter and legacy payments so it reconciles] · should the handover report list a lineman's day with no payments and no handover? [no]
- *Session-close cron (T-062a):* what "flag an unsubmitted handover" means [proposal: a count on the Owner's Home, no automatic action]. *Plan rent (T-031a):* apply a plan's new rent to all its connections at once?
- *Backups (T-096):* RPO/RTO targets [point-in-time restore: ~0 loss, back within 1 h; nightly dump: up to 24 h loss, up to 4 h] · may CI hold the private key so the monthly drill runs automatically? [manual drill] · the 12-month legacy archive needs its own bucket (the backup bucket expires after 30 days).
- *Android (T-072):* add the nightly emulator workflow from `docs/testing/android-field-uat.md`? · a deactivated lineman's held payments still need the office "release" flow (T-066).
- *Web payload (T-087a):* with a Sentry DSN set, the SDK still downloads after load, so Lighthouse still counts it.
- *Migration (T-091):* 27 business decisions are listed in `docs/migration/mapping.md` §13 (money unit, rounding tolerance, `isReceipt`, which balance is authoritative, how much history, payment method for legacy receipts, lineman login collisions, owners of the 8 operators …). Also: `migration_batches` / `migration_exceptions` / `legacy_id_map` from PLAN §7.2 don't exist yet (T-092), and `payments.method` has no "not recorded" value.
- *Migration (T-090):* the real dump is needed for column names, charset, and whether money is in rupees or paise (feeds T-091 and H-06) · the MariaDB tests don't run in CI (no MariaDB service in `web.yml`).
