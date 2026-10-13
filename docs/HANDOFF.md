# Handoff: moving to a new cloud environment

| | |
|---|---|
| **Date** | 2026-10-13 |
| **State** | Phase 0 in progress. T-001, T-002 and T-004 are merged into `feature/mvp`. Nothing is claimed or in flight. |
| **Why the move** | The previous environment's network policy blocked `dl.google.com` (Android SDK). The new environment must have full network access so Android tasks can build. |

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
| Merged PRs so far | #1 (T-001), #2 (T-004), #3 (T-002) |

**Verified on `feature/mvp` at handoff** (fresh checkout, Node 24.21.0): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm tokens:build --check`, `pnpm --filter @cb/i18n i18n:build --check` and `node scripts/tasks.mjs check --local` all pass.

---

## 2. Board status

| Status | Tasks |
|---|---|
| **Done** | T-001 Monorepo scaffold · T-002 Design tokens pipeline · T-004 i18n package |
| **Blocked** | **T-008** Android project scaffold (blocked only by the old network policy, see §4) |
| **Ready now** | T-003 Icon pipeline · T-005 Next.js web app scaffold · T-024 Domain foundations · T-020 DB foundation · T-090 Migration tooling |
| Remaining Phase 0 after those | T-006 → T-007 (web UI) · T-008 → T-009 (Android) · T-010 CI (needs T-005 + T-008) · T-011 Env config (needs T-005) |

Run `node scripts/tasks.mjs board` for the live view.

---

## 3. First steps in the new environment

```bash
# 1. Clone and switch to the integration branch
git clone https://github.com/anmol098/cable-billing-v2 && cd cable-billing-v2
git switch feature/mvp

# 2. Toolchain: Node 24 + pnpm via corepack (version pinned in package.json)
nvm install 24 && nvm use 24          # or any Node 24 install
corepack enable pnpm
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build

# 3. Check the Android toolchain is reachable (this was the blocker)
curl -sI https://dl.google.com/android/repository/repository2-3.xml | head -1   # expect HTTP 200
curl -sI https://repo1.maven.org/maven2/ | head -1                               # Maven Central; was rate-limited (429) before
# Install a JDK 17+ and the Android SDK (cmdline-tools, platform-tools, a current platform + build-tools),
# set ANDROID_HOME, and accept the licences.

# 4. Unblock the Android scaffold on the board
export AGENT_ID=coordinator
node scripts/tasks.mjs unblock T-008
node scripts/tasks.mjs next
```

---

## 4. Known blockers and how to clear them

| Blocker | Effect | Fix |
|---|---|---|
| `dl.google.com` was denied by the old network policy | No Android SDK: T-008 and T-009 can't build; T-010 (CI) depends on T-008 | Confirmed by the new environment (step 3 above). Then `unblock T-008`. |
| Maven Central returned HTTP 429 | Gradle dependency downloads may fail | Re-check in the new environment. If it persists, configure a Gradle mirror or retry later. |
| `Tokens.kt` (T-002) and `strings_generated.xml` (T-004) have **never been compiled** | They are only checked as text so far | T-008's first `./gradlew assembleDevDebug` is their first real compile. Fix any issues in the generators (`packages/design-tokens`, `packages/i18n`), never in the generated files. |
| Human tasks H-01 (accounts and secrets) and H-02 (domain, accent colour, final applicationId) | Deploys, email and Play uploads can't happen yet | The product owner does these. Agents build and test everything else with local or test configs. |

---

## 5. Recommended next wave (parallel)

All of these can start at once. Each one is independent and owns different files:

| Agent | Task | Why now |
|---|---|---|
| 1 | **T-005** Next.js web app scaffold | Unblocks T-006, T-007, T-011, T-010 and later every web task |
| 2 | **T-008** Android project scaffold (after `unblock`) | Unblocks T-009, T-010 and all Android work. Also the first compile of the generated Kotlin and XML |
| 3 | **T-003** Icon pipeline | Needed by T-007 and T-009 |
| 4 | **T-024** Domain foundations | Unblocks T-040/41/42 and T-051 (mobile contract), which lets Android build against fixtures early |
| 5 | **T-020** DB foundation | `review: required`, so a human must approve the PR. Start of the whole data layer |
| (optional) 6 | **T-090** Migration tooling | Fully independent. It needs the legacy dump only for real runs (built against a synthetic fixture) |

When the user asks only for "Phase 0", run agents 1–3 and then follow the dependency order (T-006 → T-007, T-009, T-011, T-010).

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

**Interfaces delivered so far** (details in each task file's *Completion notes*):

- **Tokens (T-002):** `import "@cb/ui/theme.css"` gives token-only Tailwind v4 utilities (`bg-bg`, `text-cash`, `text-amount`, `border-hairline`, `rounded-md`, `min-h-touch-min`, `font-numeric` …). Android: `com.cablebilling.designsystem.generated.Tokens`. Regenerate with `pnpm tokens:build`.
- **i18n (T-004):** per-namespace files in `packages/i18n/messages/{en,hi}/<ns>.json`, with machine-drafted Hindi listed in `_review`. Web output is `apps/web/messages/{en,hi}.json` (next-intl). Android output is `strings_generated.xml` with `R.string.<ns>_<key>` (only `common` + `mobile_*`). Commands: `pnpm i18n:check`, `pnpm --filter @cb/i18n i18n:build [--check]`.

---

## 7. How the previous session orchestrated agents

- One Claude Code subagent per task, each with **worktree isolation**, running in the background, with its own `AGENT_ID` (`agent-t005`, …).
- Each agent: claims the task, branches from `origin/feature/mvp`, implements, verifies, fills in completion notes, runs `complete`, rebases, pushes, opens a PR into `feature/mvp` (GitHub MCP tools) and **squash-merges it itself if `review: self`**. For `review: required` it stops and reports the PR link for a human.
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
8. review: self → squash-merge once checks pass and the PR is mergeable (rebase + retry if feature/mvp moved).
   review: required → stop and report the PR link.
If blocked: `node scripts/tasks.mjs block {ID} --reason "..."` and report. Never fake results.
Report back: PR URL, merged? (SHA), interfaces for later agents, deviations, problems.
```

---

## 8. Open items for the product owner

- **Phase 0 unblock:** confirm the new environment reaches `dl.google.com` and Maven Central.
- **H-01:** accounts and secrets (Vercel Pro, Neon, Sentry, Resend, Upstash, Turnstile, Razorpay, Play Console).
- **H-02:** domain, brand accent colour, final Android applicationId (currently `com.cablebilling.lineman`).
- **H-03:** review the Hindi drafts. The 42 `common` keys are waiting; key choices to check are Credit = "एडवांस" and Sent to office = "ऑफिस पहुँच गया".
- **H-10:** GSTIN and tax details for the ₹400 + GST subscription invoices.
- Open questions Q-02 and Q-04 to Q-12 in `docs/IMPLEMENTATION_PLAN.md` §20.
