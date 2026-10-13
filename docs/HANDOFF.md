# Handoff: current state of the build

| | |
|---|---|
| **Date** | 2026-10-13 |
| **State** | **Phase 0 agent work is complete.** T-001 … T-011 are all merged into `feature/mvp`. Nothing is claimed or in flight. Phase 1 is next. |
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
| Merged PRs so far | #1 T-001 · #2 T-004 · #3 T-002 · #5 T-003 · #6 T-005 · #7 T-011 · #8 T-006 · #9 T-008 · #10 T-010 · #12 T-007 · #13 T-009 |

**Verified on `feature/mvp`** (Node 24.21.0, pnpm 12.11.2, JDK 21): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff), the tokens / icons / i18n `--check` modes, `node scripts/tasks.mjs check --local`, the Playwright e2e suite, and in `apps/android` `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`. CI runs the same on every PR.

---

## 2. Board status

| Status | Tasks |
|---|---|
| **Done (Phase 0)** | T-001 Monorepo · T-002 Tokens · T-003 Icons · T-004 i18n · T-005 Next.js scaffold · T-006 Web primitives · T-007 Web composites + `/dev/ui` · T-008 Android scaffold · T-009 Android components · T-010 CI · T-011 Env config |
| **Ready now** | T-024 Domain foundations · T-020 DB foundation (`review: required`) · T-067 Android TTS · T-068 Android printer · T-073 Android release pipeline · T-087 Marketing pages · T-090 Migration tooling |
| **Human** | H-01 accounts + secrets · H-02 domain / accent / applicationId · H-03 Hindi review (all `_review` lists) |

Run `node scripts/tasks.mjs board` for the live view.

**Phase 0 acceptance gaps** (need a human or an emulator; this container has no `/dev/kvm`):
- T-008: the app has never been launched on an API 26 or API 35+ emulator.
- T-009: the components have not been looked at on a real screen (Robolectric can't judge the Hindi layout).

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

**Environment notes from Phase 0:**
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
| Occasional network blips in CI | One Android run failed fetching the KSP plugin; a fresh run passed. | Re-run once. A second failure is real. |

---

## 5. Recommended next wave (Phase 1, parallel)

| Agent | Task | Why now |
|---|---|---|
| 1 | **T-024** Domain foundations | Unblocks T-040/41/42 and T-051 (mobile contract). Swap `packages/ui/src/lib/money.ts` to `@cb/domain` afterwards (it is marked `TODO(T-024)`). |
| 2 | **T-020** DB foundation | `review: required`, so a human must approve the PR. Starts the whole data layer. Its package `turbo.json` must list `DATABASE_URL` (turbo strict env mode, see T-010 notes). |
| 3 | **T-067** Android TTS | Implements the `Speaker` interface from T-009; change the one binding in `app/.../voice/SpeakerModule.kt`. |
| (optional) 4 | **T-090** Migration tooling | Fully independent. |

T-068 (printer) and T-073 (Play release pipeline) are also ready, but T-073 needs H-01's Play Console account to finish.

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

**Interfaces delivered so far** (details in each task file's *Completion notes*):

- **Tokens (T-002):** `import "@cb/ui/theme.css"` gives token-only Tailwind v4 utilities (`bg-bg`, `text-cash`, `text-amount`, `border-hairline`, `rounded-md`, `min-h-touch-min`, `font-numeric` …). Android: `com.cablebilling.designsystem.generated.Tokens`. Regenerate with `pnpm tokens:build`.
- **Icons (T-003):** `<Icon name="cash" />` from `@cb/ui`; Android `R.drawable.ic_cb_<name>` (tint from Compose). Add a meaning to `packages/design-tokens/icons.json` and run `pnpm icons:build`.
- **Web app (T-005, T-011):** `apps/web` is `@cb/web` (`pnpm --filter web …`). Env via `import { serverEnv, clientEnv, requireServerEnv, baseUrls } from "@/env"`; adding a variable touches the schema, `.env.example`, `apps/web/turbo.json` and the runbook (tests catch drift). Next 16 uses `src/proxy.ts` instead of `middleware.ts`: T-026's owned path must follow.
- **Web UI (T-006, T-007):** primitives and composites from `@cb/ui` take all words as props (no next-intl inside `packages/ui`). `/dev/ui` shows everything (404 in production). T-029 must mount `ToastProvider` in the app shell and reserve space for `PageHeader`'s pinned phone action.
- **Android (T-008, T-009):** modules `:app`, `:core:designsystem`, `:detekt-rules`. Wrap screens in `CableTheme {}`; raw `.dp`/`.sp`/`Color(` outside `core/designsystem` fail detekt. Components live in `com.cablebilling.designsystem.component` (BigButton, MethodButton, NumberPad, AmountDisplay, StatusChip, CustomerRow, SyncBanner, ConfirmCard, ReceiptActionTile, SpeakButton). Strings: add a `mobile_<feature>` i18n namespace. Debug builds have a "Components (test)" catalogue launcher. AGP 9 has Kotlin built in (don't apply `kotlin-android`); ktlint runs via its CLI and detekt as one root task.
- **CI (T-010):** T-051 must name its script `openapi:build` with a `--check` mode; packages whose tests need `DATABASE_URL` must list it in their `turbo.json`.
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

- **Emulator check:** launch the dev debug APK on an API 26 and an API 35+ device/emulator (T-008), and look at the "Components (test)" catalogue in Hindi and English (T-009).
- **Branch protection:** require the CI checks `Web`, `Web e2e`, `Generated files`, `Android` on `feature/mvp` and `main`.
- **H-01:** accounts and secrets (Vercel Pro, Neon, Sentry, Resend, Upstash, Turnstile, Razorpay, Play Console).
- **H-02:** domain, brand accent colour, final Android applicationId (currently `com.cablebilling.lineman`), launcher icon and favicon. Also consider: a darker `border` token (#E5E5E5 is ~1.3:1 on white, below WCAG's 3:1 for field edges) and a `scrim` token for see-through dialog backdrops.
- **H-03:** review the Hindi drafts. Every namespace's `_review` list is waiting (`common`, `scaffold`, `ui`, `dev_ui`, `mobile_shell`, `mobile_designsystem`, …); key choices to check are Credit = "एडवांस" and Sent to office = "ऑफिस पहुँच गया".
- **H-10:** GSTIN and tax details for the ₹400 + GST subscription invoices.
- Open questions Q-02 and Q-04 to Q-12 in `docs/IMPLEMENTATION_PLAN.md` §20.
