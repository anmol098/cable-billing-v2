---
id: T-091
title: Migration: mapping document draft
phase: 5
area: migration
status: done
owner: agent-t091
claimed_at: 2026-10-14T13:47:15.228Z
branch: task/T-091-migration-mapping-document-draft
depends_on: [T-090, T-023]
review: self
claimable_by: agent
size: M
paths: [docs/migration/mapping.md]
---

# T-091 — Migration: mapping document draft

**Phase** 5 · **Area** migration · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-090, T-023

## Goal

Every legacy column mapped to the new model, with open questions explicit.

## Scope

- Map operator, costumer, vc, invoice, ledger, lineman, plan, recharge (+ any others found) to target tables.
- Document money unit evidence, isReceipt semantics, status code mapping, date sentinels, password hash algorithm evidence, known limitations (assignment history).
- List decisions needed from the business (feeds H-06).

## Acceptance criteria

- [ ] Every legacy column appears with a target or an explicit 'not migrated' reason.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `docs/migration/mapping.md`

## Notes

- Needs profiling output from a run on the real dump (human-run T-090 tooling).

## References

PLAN §15 step 2, PRD §14, BRD §13 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Built** `docs/migration/mapping.md`, the draft legacy → target mapping, written **without the real
dump** (it is not available yet; H-06 / the T-090 profile run will bring it). Nothing in it comes from
real data: it holds table names, documented column names, counts from PRD App. A, and queries.

What it contains:

- §2 what the BRD/PRD actually document about the legacy schema (8 tables, `op_id`, `isReceipt`,
  `isDeleted`, nullable `invoice` customer ref, integer bill amounts, FLOAT ledger, login/password/token
  on `lineman`, VC balance/due fields, the invoice off-by-one), labelled **Documented**, and five
  **Inferred** hypotheses (H-1 ledger = one row per VC, from 7,334 = 7,334; H-2 `invoice` mixes bills
  and receipts; H-3 recharge = per-VC renewal; H-4 rupees; H-5 the off-by-one comes from a join).
- §3 the target tables with links to every schema file, and the `legacy_source`/`legacy_id`
  convention (legacy table name + source PK as text; `migration:opening` for opening balances).
- §5 one mapping table per legacy table (`operator`, `costumer`, `vc`, `plan`, `recharge`, `invoice`,
  `ledger`, `lineman`, plus a rule for undocumented tables): documented columns, implied columns
  ("name unknown"), and a catch-all "not migrated until listed" row.
- §6 money unit, §7 `isReceipt`, §8 status codes, §9 date sentinels and time zones, §10 password hash
  shapes, §11 known limitations (assignment, status, plan history; derived allocations; precision).
  Each has the hypothesis, the evidence so far, and counts-only SQL (Q0, Q-O1, Q-X1, Q-L1, Q-M1–4,
  Q-R1–2, Q-S1–4, Q-D1, Q-P1–2, Q-I1–2, Q-V1–2) to settle it on the `legacy` copy.
- §12 the steps to finish the document after the first profile; §13 **27 numbered business
  decisions** for H-06, each with a proposed default; §14 engineering follow-ups F-1…F-9; §15 an
  empty sign-off table.

**Acceptance criterion not met (left unticked).** "Every legacy column appears with a target or an
explicit 'not migrated' reason" needs the real column list. Only `op_id`, `isReceipt` and
`isDeleted` are named in the docs; everything else is a documented *concept* with an unknown column
name, or covered by a catch-all row. The catch-all rule ("a column not listed is not migrated, and the
transform refuses to run", §4 rule 8 / F-3) keeps the import safe, but it is not a column-by-column
mapping. To finish: run the T-090 profiler and Q0 on the real dump, then §12 steps 2–4.

**Decisions taken in the draft (all proposals, for H-06 to confirm)**

- Bills: several legacy bills of one customer in one month → one `regular` invoice (RULE-05), one
  line per bill via a `migration` debit adjustment (rent lines need an assignment of the same
  customer, which only the current VC holder has). Importing the cutover month's bills this way is
  what makes `docs/runbooks/cutover.md` step 7 ("0 customers to bill") hold.
- Opening balance = legacy due − (imported bills − imported receipts): positive → `opening_balance`
  invoice, negative → `migration` credit adjustment (the schema forbids a negative opening entry).
- Legacy passwords are never carried, whatever the hash (matches the cutover runbook §3 step 2).
- Rows with no/unknown operator, null/orphan customer, duplicate codes or numbers become exceptions;
  nothing is merged or invented.

**Follow-ups found** (§14): `migration_batches` / `migration_exceptions` / `legacy_id_map` are in
PLAN §7.2 but not in `packages/db` (F-1, T-092); a migrated lineman has no `accounts` credential, so
T-092 must check Settings → Team password reset works for such a user (F-2); a column-coverage guard
(F-3); `payments.method` has no value for "not recorded" (F-5, decision 13). No new task files were
created: these fall inside T-092/T-093 scope.

**Verification**

- All SQL in the document was run with `ON_ERROR_STOP` on local Postgres 17.11 against a scratch
  `legacy` schema with stand-in column names and a few fake rows (scratch database dropped after).
  Every query runs; placeholders must be re-checked once real names replace them (F-9).
- Claims about the target were checked in the code: schema CHECKs and UNIQUEs (`packages/db/src/schema`),
  `verifyPassword` rejecting non-`$argon2` hashes, the `legacy_migration` provisioning actor
  (`packages/core/src/tenants`), and the Team password-reset action.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `node scripts/tasks.mjs check --local`
  (results in the PR). `docs/` is excluded from Biome, so lint does not check this file.

## Board log

- 2026-10-14T13:47:15.229Z claimed by agent-t091
- 2026-10-14T13:59:17.200Z completed on task/T-091-migration-mapping-document-draft
