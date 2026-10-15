---
id: T-095
title: Load testing and performance budget
phase: 5
area: qa
status: done
owner: agent-t095
claimed_at: 2026-10-14T21:55:13.801Z
branch: task/T-095-load-testing-and-performance-budget
depends_on: [T-036, T-060, T-080]
review: self
claimable_by: agent
size: M
paths: [tools/load/**, docs/testing/performance.md]
---

# T-095 — Load testing and performance budget

**Phase** 5 · **Area** qa · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-036, T-060, T-080

## Goal

Prove p95 < 2 s for common lists/search at 10× legacy scale.

## Scope

- k6 (or similar) scripts for web search/lists, mobile roster sync, payment batch.
- Run against a staging Neon branch seeded with `10x`; document results and fixes.

## Acceptance criteria

- [ ] p95 < 2 s for listed operations; report committed. **Not met here: needs real infrastructure
  (H-01: Vercel preview + Neon branch + Upstash). Moved to T-095a.** The tooling, the budget, the gate and
  the runbook are done and proven locally (see Completion notes); local numbers are tooling smoke only.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `tools/load/**`
- `docs/testing/performance.md`

## References

PRD §11 (Performance, Scale) — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `tools/load/` (`@cb/load`) | The load tool. `pnpm load <run\|warm\|plan\|check>` (root script → `pnpm --filter @cb/load load`). Plain Node 24 `fetch`, no new third-party dependency (only `@cb/contracts`, `@cb/db` for the seed's user plan). |
| `src/scenarios/` | `billing` (billing-scheduler + job-worker crons until every tenant's run is `done`), `sync` (morning burst: config, full roster in pages of 500, customer detail, delta), `counter` (`/payments/new` Server Actions find + save), `reports` (20 list/report pages, 4 kinds of customer search, a customer's profile/bills/payments), `exports` (CSV, widest ranges), `payments` (evening burst: 50-item `/payments:batch`, a replay that must be all `duplicate`, receipt actions, day totals, delta). |
| `src/budget.ts` | `BUDGET_RULES` (24 rules, ids `B-…`) and `evaluateBudget`. |
| `src/profiles.ts` | `smoke` (8 users), `legacy` (60 phones, 8 clerks, 16 office users, 8 owners: 76 sign-ins), `10x` (420 users). |
| `src/auth.ts` | `SignInGovernor` (≤ 90 real sign-ins per run, hard max 100, one per account; ≤ 550 refreshes), `SessionCache` (`tools/load/.cache/sessions.json`, 0600, git-ignored), web sign-in by the no-JS login form post, phone sign-in/refresh. |
| `src/report.ts` | `summary.json` (schema `cb-load-result/1`) + `summary.md`; local/private targets are labelled "tooling smoke … not a capacity measurement". `check` re-evaluates a stored result. |
| `src/testing/fake-target.ts` | In-process fake of the app for the tests; checks request bodies with the contract's Zod schemas. |
| `docs/testing/performance.md` | The budget (each number tied to PRD §11 / PLAN, *proposed* ones marked), scenarios, rate-limit plan, options, runbook for a Vercel preview + Neon branch, a ready-to-paste manual CI workflow, local smoke results. |

**Decisions**
1. **No k6/Artillery.** A new binary or heavy dependency, and neither speaks Next.js Server Actions. Node
   `fetch` with one cookie/bearer session per virtual user and exact nearest-rank percentiles is enough.
2. **Real user paths, no bypasses.** Web sign-in posts the login form as a browser without JavaScript does
   (hidden `$ACTION_*` fields → 303 + session cookie); counter payments call the page's Server Actions with
   ids read from the page's RSC payload; phones use the mobile contract. Both web paths depend on Next 16
   internals and fail loudly (`NextProtocolError`) if Next changes them. No rate limit was touched; the tool
   never spoofs `X-Forwarded-For`. Sign-ins are cached between runs and `warm` prepares big profiles in
   15-minute windows; a run that would need too many sign-ins is refused before any load.
3. **Users from the seed's own plan** (`planOperators`), so the tool never guesses logins (each wrong guess
   would spend a sign-in).
4. **Timings are to the last byte and include the network**; each run records a baseline (fastest of 5
   `/api/health` round trips) so a far-away load generator is visible in the report.
5. **Fails honestly:** a user who can't sign in or whose script throws stops the scenario (run fails); count
   rules ("0 failed jobs") count only for scenarios that finished.
6. **Budget numbers not in the PRD are marked proposed** (B-EXPORT 60 s, B-BILLING-RUN 30 min legacy / 5 h
   10×); B-SYNC-FULL 10 s and B-PAY-BATCH 10 s are derived from PLAN §10 / T-061. Product owner please confirm.
7. **CI workflow not added** (`.github/workflows` isn't an owned path, and there is no target before H-01):
   the doc has a `workflow_dispatch`-only YAML with secrets in a `load-test` environment. T-095a adds it.
8. `LOAD_FORBIDDEN_HOSTS` refuses the production host; `LOAD_VERCEL_BYPASS_SECRET` handles protected previews.

**Deviations / shared files**
- Root `package.json`: one script `"load"`. `pnpm-lock.yaml`: the new workspace importer only.
- New follow-up task **T-095a** (capacity run on a Vercel preview + Neon branch, add the CI workflow).
- Acceptance criterion left unticked (needs H-01), moved to T-095a.

**Findings for T-095a (local, tooling smoke only; not capacity)**
- With 60 phones pushing 50-item batches at once on one local Node process + local Postgres (4 shared
  CPUs, load avg ~10), `/payments:batch` p95 was 25.8 s, close to T-061's 30 s batch budget; receipt actions
  (100 per request) 11.6 s. Both post item by item in one request. Worth watching on the real run.
- At legacy size the billing run billed 8 tenants (6,519 bills, 228 nothing-to-bill, 0 failed) in 111–137 s
  in one job-worker invocation.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; T-095 commit 736f8d3 on `feature/mvp` fd84c43, then rebased on 3ccab93)
- Local tooling smoke against `next start` (production build) on a fresh scratch DB seeded
  `--scale legacy --as-of 2026-09-30`, **tooling smoke results on a shared, loaded container, not a capacity
  measurement** (full tables in `docs/testing/performance.md` §6):
  - `pnpm load run --base-url http://localhost:3295 --profile smoke --gate` (all 6 scenarios): **PASS**,
    exit 0; 8 sign-ins; billing 137 s, 8/8 runs done; worst page p95 1,045 ms; 40 phone + 6 counter payments;
    replays all `duplicate`; 4 files.
  - `pnpm load run … --profile legacy --scenarios sync,counter,reports,exports,payments --gate`: **FAIL**,
    exit 1 (the gate working): 0 request errors in 43 metrics, 6,000 + 80 payments posted, 0 rejected / 0
    `retry_later`; p95 over budget on 15 of 20 pages (2.1–2.7 s), two searches, roster page/delta,
    payment batch (25.8 s) and receipt actions (11.6 s), at load average 9–11.
  - Database afterwards: 6,519 October bills, 6,126 payments posted by the runs. Scratch DBs dropped.
- `tools/load` tests (35): every scenario end to end against the fake target with contract-valid bodies;
  one sign-in per user; cache reuse (0 sign-ins on the second run); refusal before load when the sign-in
  budget is too small; `warm` in windows; failed sign-in fails the run; missing `CRON_SECRET`; unhealthy
  target (exit 3); a failing page (exit 1 with `--gate`, `check` agrees); budget evaluation and the doc ↔
  code rule-id check; Next.js form/action parsing; ids (UUIDv7, provisional refs valid per the contract,
  IST day); personas (126 active legacy linemen, as in the seeded DB); options and forbidden hosts.
- Root (after the rebase): see the PR for `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
  `TURBO_FORCE=1 pnpm test --concurrency=1`, `pnpm build`, `pnpm generate` (no diff),
  `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T21:55:13.801Z claimed by agent-t095
- 2026-10-15T03:22:14.157Z completed on task/T-095-load-testing-and-performance-budget
