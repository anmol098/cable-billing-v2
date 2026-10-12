# Task board: guide for agents

This folder is the work board for building Cable Billing. Each `T-xxx` / `H-xx` file is one task. Many agents can work at the same time, each in its own **git worktree** on its own **task branch**, and each merges into the shared **integration branch**.

> **Read first:** `CLAUDE.md` (repo conventions), then the task file you claim, then the sections of
> [`docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md) it references.
> The BRD/PRD in `docs/` are the source of truth for business rules.

---

## 1. How the board works

| Thing | Where |
|---|---|
| The board | The `tasks/*.md` files **as they are on the integration branch** (`feature/mvp`, configured in `tasks/board.config.json`) |
| A task's state | Its front matter: `status`, `owner`, `claimed_at`, `branch` |
| The tool | `node scripts/tasks.mjs <command>` (no install needed, Node ≥ 20) |

**Statuses**

| Status | Meaning | Changed by |
|---|---|---|
| `todo` | Nobody is working on it | initial / `release` |
| `claimed` | An agent owns it (includes "PR open, in review") | `claim` (pushed straight to the integration branch) |
| `blocked` | The owner can't continue; the reason is in the Board log | `block` / `unblock` |
| `done` | Merged into the integration branch | **your PR** (you run `complete` on your branch, and it becomes true when the PR merges) |

A task is **ready** when it is `todo`, `claimable_by: agent`, and every task in `depends_on` is `done`.

**Why claims can't collide:** `claim` edits the task file in a temporary worktree, commits, and pushes to the integration branch. Git only accepts fast-forward pushes, so if two agents claim at once, one push is rejected. The loser re-reads the board, sees the task is taken, and exits with code `2`. Agents never edit board status by hand.

---

## 2. Branch model

```text
main ─────────────────────────────────────────────▶ (releases; humans merge feature/mvp → main at phase gates)
  └─ feature/mvp  (integration branch; holds the board)
        ├─ task/T-020-db-foundation-client-tenant-transactions   ← your worktree
        ├─ task/T-024-domain-foundations-money-periods-busine    ← another agent's worktree
        └─ …
```

- **Never** push work commits to `main` or directly to `feature/mvp`. The only direct pushes to `feature/mvp` are the board commits made by `scripts/tasks.mjs`.
- Each task is one branch, one worktree and one PR into `feature/mvp`, squash-merged.

---

## 3. Workflow, step by step

### 3.1 Find a task

```bash
git fetch origin
node scripts/tasks.mjs next              # ready tasks, best first (lower phase, unblocks the most)
node scripts/tasks.mjs show T-024        # read it fully before claiming
```

Pick a task you can finish in one session. Prefer tasks that unblock others (the `UNBLOCKS` column).

### 3.2 Claim it (atomic)

```bash
export AGENT_ID="<your-unique-agent-name>"     # e.g. claude-web-3; must be stable for your session
node scripts/tasks.mjs claim T-024
```

- Exit code `0` means it's yours. The output prints the branch name to use.
- Exit code `2` means someone else got it or it isn't ready. Run `next` again and pick another.
- You can hold **one** task at a time. Finish or release it before claiming another.

### 3.3 Create your isolated worktree

```bash
git fetch origin feature/mvp
git worktree add ../wt-T-024 -b task/T-024-<slug> origin/feature/mvp
cd ../wt-T-024
```

If your harness already put you in an isolated worktree (for example Claude Code's `isolation: "worktree"`), just create the branch there instead:
`git switch -c task/T-024-<slug> origin/feature/mvp`.

Always branch from `origin/feature/mvp` **after** claiming, so your branch contains the claimed task file.

### 3.4 Build it

1. Read the task's **References**, and the completion notes of the tasks in `depends_on`, which describe the interfaces you build on.
2. Stay inside **Files this task owns** (plus the shared files in §6). If you must change something owned by another task, see §7.
3. Write the tests listed under **Tests required**. Tenant-scoped services must register cases with the tenant isolation harness (from T-025).
4. Commit early and often on your task branch, and push it (`git push -u origin task/T-024-<slug>`) so your work is never only on one machine.

### 3.5 Verify (definition of done)

All of these must hold before you open the PR:

- [ ] Every **Acceptance criteria** checkbox in the task file is met. Tick them in the file.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass (once T-001 exists; until then, the checks the task itself sets up).
- [ ] Android tasks: `./gradlew ktlintCheck detekt testDevDebugUnitTest assembleDevDebug` passes in `apps/android`.
- [ ] Generated files are regenerated and committed (`pnpm generate`), and `--check` modes pass.
- [ ] No hard-coded colours, sizes or user-facing strings. Tokens and i18n keys only, with both `en` and `hi` present (mark machine-drafted Hindi for review, see T-004).
- [ ] Money is integer paise, times are UTC `timestamptz`, and business dates are IST.
- [ ] No secrets, `.env` files, legacy dump data or real personal data in the diff.
- [ ] `node scripts/tasks.mjs check --local` passes.
- [ ] **Completion notes** filled in: what you built, interfaces others will use, decisions, deviations from the plan, follow-ups, and how you verified it.

### 3.6 Mark done and open the PR

```bash
node scripts/tasks.mjs complete T-024     # sets status: done in YOUR branch's task file
git add -A && git commit -m "T-024: complete task"
git fetch origin feature/mvp && git rebase origin/feature/mvp   # resolve conflicts (see §6)
pnpm install && pnpm generate && pnpm test                     # re-verify after rebase
git push --force-with-lease -u origin task/T-024-<slug>
```

Open a PR **into `feature/mvp`** (GitHub MCP tools or `gh pr create --base feature/mvp`):

- Title: `T-024: <task title>`
- Body: follow `.github/pull_request_template.md` (after T-010; before that, include the task ID, summary, how verified, and screenshots for UI).

### 3.7 Merge

| `review:` in task | Who merges |
|---|---|
| `self` | You may squash-merge once CI is green and the branch is up to date with `feature/mvp`. |
| `required` | Wait for a human (or a designated reviewer agent) to approve. Address review comments on the same branch. Then squash-merge. |

If `feature/mvp` moved while your PR was open, rebase again and re-run checks before merging. When the PR merges, your task is `done` on the board, because the PR carried the status change.

### 3.8 Clean up

```bash
cd <main checkout> && git worktree remove ../wt-T-024 && git branch -D task/T-024-<slug>
```

Then go back to 3.1.

---

## 4. Task file anatomy

```yaml
---
id: T-044                      # unique; agent-created tasks use a letter suffix, e.g. T-044a
title: Billing run service (preview, run, retry, catch-up)
phase: 2                       # delivery phase in PLAN §18 (ordering hint, not a lock)
area: core                     # repo | design-system | i18n | web | web-ui | db | domain | core | api | android | infra | qa | migration | human
status: todo                   # todo | claimed | blocked | done   ← only the script / your PR changes this
owner:                         # AGENT_ID of the claimer
claimed_at:
branch:                        # task/T-044-…
depends_on: [T-040, T-041]     # must all be done before claim
review: required               # self | required
claimable_by: agent            # agent | human  (H-xx tasks are for humans)
size: L                        # S ≈ <½ day, M ≈ 1 day, L ≈ 2–3 days of focused work
paths: [packages/core/src/billing/**]   # files this task owns
---
```

The body has: Goal, Scope, Out of scope, Acceptance criteria, Tests required, Files this task owns, Notes, References, Completion notes, and the Board log (appended by the script).

---

## 5. Rules every agent follows

1. **One claimed task per agent.** Don't start work before `claim` succeeds.
2. **Stay in your lane.** Edit only your task's `paths` and the shared files in §6.
3. **The docs win.** If the code from a dependency contradicts the BRD/PRD/plan, follow the docs, and note the conflict in your completion notes and PR. Don't silently "fix" another task's area.
4. **Don't change decisions.** The decisions log (`D-xx`) and business rules belong to the product owner. Propose changes in your PR description. Never edit `docs/BRD.md`, `docs/PRD.md` or the decisions log yourself.
5. **Never weaken safety to get green.** Don't skip or delete tests, bypass RLS or tenant scope, or relax constraints.
6. **Leave a trail.** Completion notes are how the next agent learns your interfaces.
7. **Never commit** secrets, `.env`, legacy dumps, or real customer data.

---

## 6. Avoiding merge conflicts between parallel agents

The layout is designed so that parallel tasks touch different files. These **shared files** may be edited by any task, carefully:

| Shared file | Rule |
|---|---|
| `pnpm-lock.yaml` | Never hand-merge. On conflict: take `origin/feature/mvp`'s version, run `pnpm install`, commit. |
| Your package's `package.json` dependencies | Add only what you need. Root `package.json` belongs to T-001 (later: add a script only if your task needs one). |
| `packages/db/src/schema/index.ts` | Append your module's export line only. |
| `packages/db/migrations/**` | **Generate migrations last, right after rebasing.** If `meta/_journal.json` or migration numbers conflict: delete *your* generated migration files, rebase, regenerate, re-run tests. Never edit a migration that is already on `feature/mvp`. |
| `packages/i18n/messages/{en,hi}/<namespace>.json` | Each feature has its own namespace file. Only `common.json` is shared: append keys, don't reorder. |
| Generated outputs (`theme.css`, `Tokens.kt`, icons, `apps/web/messages/*.json`, `strings_generated.xml`, `openapi.json`) | Never hand-edit or hand-merge. Regenerate from source after rebasing. |
| `apps/android/gradle/libs.versions.toml`, `app/build.gradle.kts` | Append dependency lines only. On conflict, keep both sides. |
| `apps/android/app/src/main/AndroidManifest.xml` | Add only the permissions/components your task needs. |
| `apps/web/vercel.json` (crons) | Add your cron entry only. |
| Placeholder pages created by T-029 | The task that owns the section replaces its placeholder file. |

Navigation, the app shell and route placeholders are created up front (T-029), so feature tasks don't edit shared navigation files.

---

## 7. When things go wrong

| Situation | What to do |
|---|---|
| **You're blocked** (missing dependency behaviour, unclear requirement, needs a human or a secret) | `node scripts/tasks.mjs block T-044 --reason "needs RAZORPAY test keys (H-01)"`. Push your WIP branch. If the blocker is long, `release` instead so others aren't held up. |
| **You can't finish** | Push your branch, write what's done and what's left in completion notes on the branch, then `node scripts/tasks.mjs release T-044 --reason "partial work on branch task/T-044-…"`. The next agent continues from your branch. |
| **You need a change in another task's files** | If that task is `done`: make the smallest change yourself and explain it in the PR. If it's `claimed`: don't touch it. Create a follow-up task (below) or coordinate through its owner's PR. |
| **You discover new work** | Create a task file in your PR using `tasks/TEMPLATE.md`. ID: the parent ID plus a letter (`T-044a`, `T-044b`), so parallel agents never collide on IDs. It becomes claimable after your PR merges. |
| **A stale claim** (claimed > 48 h, no pushes on its branch for 24 h) | A coordinator (human or designated agent) may run `release T-0xx --force --reason "stale"`. Workers don't force-release others' tasks. |
| **Push of a claim keeps failing** | The script retries 6 times with backoff. If it still fails, check `git fetch origin feature/mvp` works and that you have push access. |

---

## 8. For the coordinator (human)

1. **Create the integration branch once** (from the branch or commit holding this board):
   ```bash
   git fetch origin && git push origin origin/<branch-with-board>:refs/heads/feature/mvp
   ```
   Protect `feature/mvp` in GitHub: require PRs with green CI for normal commits. Board commits are pushed directly by agents, so either allow direct pushes for the agents' account or move to a bot account.
2. **Do the human tasks** (`H-xx`). H-01 (accounts and secrets) unblocks deployments. H-02 (domain/applicationId) is needed before Play production.
3. **Launch workers.** Each worker gets the prompt in §9. Start with 2–3 agents in Phase 0 (T-001 first; it unblocks almost everything), then scale to 5–8 once the foundations land.
4. **Review `review: required` PRs.** These cover money, security, tenancy and migration.
5. **Watch the board:** `node scripts/tasks.mjs board`.
6. **At each phase gate** (PLAN §18 exit criteria), merge `feature/mvp` → `main` through a PR.

### Expected parallelism (critical path)

```text
T-001 ─┬─ T-002 ─ T-003 ─────────────┐
       ├─ T-004 ─────────────────────┤
       │        T-005 (needs 002,004) ─ T-006 ─ T-007 ─ T-029 (+T-026) ─ feature pages …
       │        T-008 (needs 002,004) ─ T-009 ─ Android features (need T-051)
       ├─ T-020 ─ T-021 ─ T-022 ─ T-023 ─ financial services …
       ├─ T-024 ─┬─ T-040 / T-041 / T-042 (pure domain, fully parallel)
       │         └─ T-051 (mobile contract; unblocks all Android work early)
       └─ T-090 (migration tooling, independent)
```

---

## 9. Prompt for launching a worker agent

Copy this into a new Claude Code session (or a subagent with worktree isolation):

```text
You are a worker agent on the Cable Billing monorepo.
1. Read CLAUDE.md and tasks/README.md fully.
2. Set AGENT_ID to "<unique-name>".
3. Run `node scripts/tasks.mjs next`, pick the top ready task you can finish, read it with `show`,
   then `claim` it. If the claim exits with code 2, pick another.
4. Create your task branch from origin/feature/mvp in an isolated worktree, as described in tasks/README.md §3.3.
5. Implement the task inside its owned paths. Follow the docs and the definition of done (§3.5).
6. Fill in completion notes, run `complete`, rebase on origin/feature/mvp, re-verify, push,
   and open a PR into feature/mvp titled "T-xxx: <title>".
7. If review is "self" and CI is green, squash-merge. If "required", stop and report the PR link.
8. If blocked, use `block` or `release` with a clear reason. Never touch another agent's claimed task.
Then report: task ID, PR link, and anything the next agent should know.
```

---

## 10. Command reference

```text
node scripts/tasks.mjs help
node scripts/tasks.mjs next  [--area web]                  # what can I claim?
node scripts/tasks.mjs list  [--status todo] [--phase 2] [--area android] [--owner NAME]
node scripts/tasks.mjs board                               # everything, grouped by status
node scripts/tasks.mjs show  T-044
node scripts/tasks.mjs claim T-044 [--agent NAME]
node scripts/tasks.mjs block T-044 --reason "…"
node scripts/tasks.mjs unblock T-044
node scripts/tasks.mjs release T-044 --reason "…" [--force]
node scripts/tasks.mjs complete T-044                      # on your task branch, before the PR
node scripts/tasks.mjs check [--local]                     # validate all task files (CI runs --local)
```

All read commands look at `origin/feature/mvp` by default. Add `--local` to read your working tree instead (useful before the integration branch exists).
