---
id: T-036
title: Seed data generator for dev and preview
phase: 1
area: db
status: done
owner: agent-t036
claimed_at: 2026-10-13T13:37:55.087Z
branch: task/T-036-seed-data-generator-for-dev-and-preview
depends_on: [T-023, T-024]
review: self
claimable_by: agent
size: M
paths: [packages/db/src/seed/**, packages/db/package.json]
---

# T-036 — Seed data generator for dev and preview

**Phase** 1 · **Area** db · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-023, T-024

## Goal

Realistic fake data so UI and performance work don't need the legacy dump.

## Scope

- `pnpm db:seed --scale small|legacy|10x`: operators (incl. two with the same name), areas, plans, customers with Indian names (Hindi + English), VCs incl. reused VCs, 12 months of invoices/payments/adjustments generated through domain functions where available (fallback: direct inserts marked TODO).
- Deterministic with a seed value; never uses real personal data.
- Neon preview branches run `small` automatically (document in environments runbook).

## Acceptance criteria

- [x] `legacy` scale ≈ 8 operators / 7.6k customers / 146k invoices finishes in < 3 min locally.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/seed/**`
- `packages/db/package.json`

## References

PRD §11 (scale), PRD Appendix A — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What was built** (`packages/db/src/seed/`, export `@cb/db/seed`, script `db:seed` in `packages/db` and the root)

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/<empty db> pnpm db:seed --migrate   # small
pnpm db:seed --scale legacy --seed 7 --as-of 2026-10-13   # deterministic for (scale, seed, as-of, months)
pnpm db:seed --dry-run --scale legacy                      # generate, print counts + hash, no database
pnpm db:seed --help                                        # every option
```

| Scale | Operators / customers / linemen / months | Rows (seed 1, as-of 2026-10-13) |
|---|---|---|
| `small` (default) | 3 / 150 / 6 / 12 | 1,551 invoices, 1,092 payments, 2,663 ledger entries |
| `legacy` | 8 / 7,616 / 134 / **23** | 148,069 invoices, 107,898 payments, 7,280 VC assets, 8,084 assignments, 257,348 ledger entries |
| `10x` | 80 / 76,160 / 1,340 / 23 | ~10× legacy (not run here) |

Options: `--seed N` (default 1), `--as-of YYYY-MM-DD` (default today IST), `--months N`, `--migrate`,
`--allow-remote`, `--if-empty` (exit 0 when the database already has operators: safe in automation),
`--no-password`, `--concurrency N` (operators inserted at once, default 3), `--verify N` (customers per operator
re-read and checked with `checkLedger` after inserting, default 25), `--dry-run`. Target: `DATABASE_URL_UNPOOLED`,
else `DATABASE_URL` (must be set in the shell). Exit codes: 0 ok, 1 failed, 2 refused / bad arguments.

**What is seeded** (per operator, everything through `withTenant`)
- `operators` (operators 1 and 2 are both "Shiv Cable Network", FR-002; settings: the D-18 policy alternates
  `charge_full_month` / `start_next_month`, invoice prefix from the initials, fake office phone, receipt footer),
  `subscriptions` (`active`), `users` (owner, 1–2 staff, linemen; the last of ≥ 4 linemen is `disabled` with a
  revoked device), `accounts` (Better Auth `credential`, see logins), `devices` (one per lineman, codes `K00`…),
  `areas` (English and Devanagari names), `plans` (4–6 active from a catalogue, a ₹0 "Free" plan on every third
  operator, a retired "Old Basic").
- `customers`: synthetic names from built-in word lists (≈30 % Devanagari), codes auto `{seq}` (even operators, with
  the `customer_code` counter) or operator-defined `A-001` (odd operators), phones in the fictional `555xxxxxxx`
  range; ≈82 % existed before the window (imported at onboarding), the rest join during it; ≈12 % churn (inactive).
- Connections: `vc_assets` (12-digit numbers, some typed with spaces), `vc_assignments`, `assignment_events`
  (activated, suspended/reactivated, plan_changed, disconnected with a reason). **Sequential VC reuse** (PRD §15 #6,
  RULE-07): a VC freed by a disconnection goes to a later joiner whose start is after the old end date (legacy:
  774 reused VCs, 29 reused twice); ≈6 % of customers have two VCs; a quarter of the freed, never-reused VCs are
  `retired`.
- Money, simulated day by day through the domain functions: monthly `billing_runs` + `billing_run_items` with
  `buildInvoice` (T-040) on the 1st (only what was recorded before the run), `applyCredit` (T-041) after each
  invoice, payments with `allocate` (cash/UPI; Android 75 % with device and provisional ref, else web counter;
  receipts `R-YYMM-NNNNN` from the gap-free counter), reversals with `reverse` (≈0.4 %, by the owner), plan changes
  with `planChangeForPeriod` and new connections / reactivations after the run with `midMonthStartForPeriod`
  (T-042), manual debit/credit adjustments, opening-balance invoices for ≈12 % of imported customers, review flags
  (`customer_inactive`, `collector_mismatch`; ≈70 % resolved), `collection_sessions` (past days accepted with an
  exact handover, the `asOf` day open), `customer_balances`, `counters` (next values after the seeded numbers).
  Payment behaviour profiles: regular, late, partial, advance (credit), defaulter.
- **Every customer's account is checked with `checkLedger` in memory before anything is written** (a violation
  throws), and a sample is read back from the tables and checked again after inserting.

**Logins for dev / previews** (web sign-in, T-026; linemen sign in on Android once T-028 lands): `seed-op01-owner`, `seed-op01-staff1`,
`seed-op01-lineman01` … (`opNN` = operator number), password **`seed-dev-password`**. The seed stores a precomputed
argon2id PHC hash with T-026's parameters (m = 19456, t = 2, p = 1; made and verified with `@node-rs/argon2` 2.2.2,
the version on the T-026 branch) in `accounts` (`provider_id = 'credential'`, `account_id` = user id, as T-026's
e2e test does). `--no-password` skips the accounts; `CB_SEED_PASSWORD_HASH` overrides the hash. Owners and staff
have emails `<login>@seed.cable.test`. T-026 merged while this task was open: the layout matches its completion notes (provisioning section) and `packages/core/src/auth/password.ts` (same argon2id parameters).

**Interfaces for later tasks** (`@cb/db/seed`)
- `seedDatabase(db, { scale, seed?, asOf?, months?, passwordHash?, concurrency?, verifyPerOperator?, log? })` →
  `SeedResult` (counts by table, hash, logins, operators, verified); throws `SeedRefusedError` on a non-empty DB.
- `generateSeed(options)` / `generateOperator(spec, options)` (no database), `datasetHash`, `datasetCounts`,
  `planOperators`, `SCALE_CONFIGS`, `checkSeedTarget`.
- `readLedgerState(tx, operatorId, customerId)` → T-041 `LedgerState` (the `ledger.test.ts` mapping) and
  `verifyLedgerSample(db, { perOperator })` → `{ checked, failures }`: T-052 (nightly invariants) can reuse
  `readLedgerState`. T-095 (load tests) can use `--scale 10x`; the web/Android feature tasks get realistic data.

**Decisions**
1. **Domain functions + direct inserts, not core services.** `@cb/db` can't depend on `@cb/core` (core depends on
   db), so the seed does not call T-046's `postPayment`; it writes the rows exactly as `postPaymentInTx` and
   `ledger.test.ts`'s reference services do (same columns, snapshots, `outstanding_after_paise`, receipt numbering,
   session totals). Every money amount comes from the T-040/T-041/T-042 functions; only the opening-balance amount
   and the payment amounts (what a customer chooses to pay) are drawn by the generator. No TODO fallbacks remain.
2. **Bulk inserts:** one `INSERT … SELECT FROM unnest($1::type[], …) WITH ORDINALITY ORDER BY ord` per 5,000 rows;
   columns come from the Drizzle tables (rows are typed with `$inferInsert`; generated and identity columns
   skipped). Each operator is one `withTenant` transaction (RLS on, role `app_rw`); up to 3 operators insert
   concurrently while the next one is generated. Rows are inserted once in their final state (debit adjustments
   already carry the `invoice_id` that billed them, payments their final review state), so nothing is ever updated
   or deleted and the append-only triggers are not involved. A test seeds through a **non-owner shape-B login role**
   to show no owner rights are needed (only `--migrate` needs the owner).
3. **Safety:** refuses `VERCEL_ENV=production` or `CB_SEED_FORBIDDEN=1` (no override), non-local hosts without
   `--allow-remote`, and any database that already has operators (so a production URL is refused even with the
   flag). Never wired into a build.
4. **Determinism:** a seeded PRNG (sfc32 seeded by cyrb128) with one independent stream per operator, a seeded
   UUIDv7 generator on the simulated clock, timestamps derived from `asOf`; nothing reads the real clock except the
   default `asOf`. `datasetHash` (SHA-256 over every row as sent to the driver) is printed and tested. In the
   database, `ledger_entries.seq` interleaves across operators inserted concurrently (per customer it is in order).
5. **History length:** the scope says 12 months, and `small` uses 12; but 146k invoices for 7.6k customers needs
   ≈19 bills each, so `legacy` and `10x` simulate **23 months** (with churn and growth: 148k invoices). `--months`
   overrides.
6. Open questions follow the current defaults: T-041 Q-A (debit adjustments reach the ledger through the next
   invoice), Q-B (credit is applied when the next invoice is issued), Q-C (oldest credit by `posted_at`), Q-D (an
   opening-balance invoice is older than the regular one of the same period, by id); T-040 ₹0 invoices are created
   (free plan); assignment events are recorded on their effective date (no back-dating).

**Deviations / shared files**
- Root `package.json`: added `"db:seed": "pnpm --filter @cb/db db:seed"` (the scope names `pnpm db:seed`).
- `docs/runbooks/environments.md` (T-011, done): new §4.13 "Seed data on staging and preview branches" (previews get
  `small` by inheritance from the seeded `staging` parent branch; the command with `--allow-remote --if-empty`;
  production guards; logins), and the two "once T-036 lands" references updated (§4.2 step 8, §5).
- `packages/db/README.md` (T-020, done): a short "Seed data (T-036)" section pointing at the CLI and the runbook.
- Not seeded: customer contact-change history, receipt links/actions, audit events, jobs (nothing in the scope
  needs them). A CI job that seeds each preview branch is not wired (no Neon access here): the runbook documents
  the inheritance setup and the idempotent command for such a job.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; 4 CPUs shared with other agents)
- **Timed `legacy` run** into a fresh scratch database: `pnpm db:seed --migrate --scale legacy --as-of 2026-10-13`
  → seeding 39.6 s (42.3 s wall including migrations) at load average 12–17 on 4 CPUs; an earlier run at load 10
  took 27.8 s. 8 operators / 7,616 customers / 148,069 invoices; `checkLedger` on 200 sampled customers: 0
  failures; SQL checks over the whole database: Σ ledger = `customer_balances.balance_paise` for every customer,
  no invoice with negative outstanding, no over-allocated payment. Generation alone (`--dry-run`): ~11–14 s.
- Tests (`packages/db/src/seed/*.test.ts`, 29 tests): PRNG determinism, forks, ranges; guard (local, remote,
  production, bad URLs); CLI parsing, refusals without touching a database, help, dry run; generator determinism
  (same seed → same hash and counts; another seed or `asOf` → different), two operators with the same name, Hindi
  and English names, only `555` phones, sequential VC reuse (previous end < next start, different customers), one
  regular invoice per customer and period, lines = charges, gap-free invoice numbers, every adjustment source,
  reversals, review flags, credit, nothing after `asOf`; **DB:** `small` seeded into a fresh harness database →
  table counts equal the generated rows, hash equals `generateSeed`'s, **`checkLedger` passes for all 150 customers
  read back**, balances = Σ ledger, a second seed is refused; and seeding through a shape-B login role.
- `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9; @cb/db 28 files / 246 tests), `pnpm build` (9/9),
  `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T13:37:55.088Z claimed by agent-t036
- 2026-10-13T14:06:01.120Z completed on task/T-036-seed-data-generator-for-dev-and-preview
