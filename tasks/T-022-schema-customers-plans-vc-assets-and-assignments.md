---
id: T-022
title: Schema: customers, plans, VC assets and assignments
phase: 1
area: db
status: done
owner: agent-t022
claimed_at: 2026-10-13T12:25:00.767Z
branch: task/T-022-schema-customers-plans-vc-assets-and-ass
depends_on: [T-021]
review: required
claimable_by: agent
size: M
paths: [packages/db/src/schema/customers.ts, packages/db/src/schema/connections.ts, packages/db/src/schema/plans.ts, packages/db/src/schema/index.ts, packages/db/migrations/**]
---

# T-022 — Schema: customers, plans, VC assets and assignments

**Phase** 1 · **Area** db · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-021

## Goal

Master data tables with the integrity rules enforced by the database.

## Scope

- `customers` with `customer_code_norm` and UNIQUE (operator_id, customer_code_norm); `customer_contact_changes`.
- `plans` (monthly_amount_paise, status active|retired).
- `vc_assets` UNIQUE (operator_id, vc_number_norm); `vc_assignments` with the GiST EXCLUDE constraint preventing overlapping date ranges for the same asset; `assignment_events`.
- Search indexes: trigram (pg_trgm) on name, btree on code/phone/vc_number_norm.
- `legacy_source`, `legacy_id` columns on migrated tables.

## Acceptance criteria

- [x] Same customer code allowed across operators, rejected within one (PRD §15 #2).
- [x] Overlapping assignment for the same VC is rejected by the DB; sequential reuse is accepted (PRD §15 #6).

## Tests required

- Integration tests for both constraints and cross-tenant composite FK rejection.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/schema/customers.ts`
- `packages/db/src/schema/connections.ts`
- `packages/db/src/schema/plans.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/migrations/**`

## References

PLAN §7.2, FR-003, FR-004, FR-005, FR-006, FR-007, RULE-02, RULE-06, BR-03 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

All six tables are tenant tables in `public`: `operator_id`, `tenantKey` (UNIQUE `(operator_id, id)`),
the standard `tenant_isolation` policy, RLS enabled, no `app_platform` policy (default deny). T-020's
security audit passes with them. Every reference between tenant tables is a composite FK
`(operator_id, x_id) → x(operator_id, id)`, so a cross-tenant reference fails with 23503 even for the
owner role. Each module's header comment documents its rules.

**Tables** (`src/schema/*.ts`; Drizzle exports in parentheses)

| Module | Table | Key points |
|---|---|---|
| customers | `customers` (`customers`) | `customer_code` (as typed), `customer_code_norm` (**stored generated column**), `name`, `phone`, `alt_phone`, `address`, `area_id` (nullable, composite FK to `areas`), `status` `customer_status` (`active\|inactive`), `kyc` jsonb object (default `{}`), timestamps, `legacy_source/id`. **UNIQUE `(operator_id, customer_code_norm)`** (`customers_operator_code_unique`). CHECKs: the normalised code is not empty and ≤ 64 chars, the name is not blank, `phone`/`alt_phone` match `^\+?[0-9]{6,19}$`, `kyc` is an object, legacy columns both-or-neither. |
| customers | `customer_contact_changes` (`customerContactChanges`) | FR-004: `customer_id`, `field` `contact_field` (`phone\|alt_phone`), `old_value`, `new_value` (NULL = none), `actor_id` (FK users; required unless `source = 'import'`), `source` `contact_change_source` (`web\|android\|import`), `at`. CHECK old ≠ new. **Append-only** for every role. Index `(operator_id, customer_id, at)`. |
| plans | `plans` (`plans`) | `name`, `monthly_amount_paise` bigint ≥ 0 (₹0 allowed), `status` `plan_status` (`active\|retired`), timestamps, legacy. Partial UNIQUE `(operator_id, lower(btrim(name))) WHERE status = 'active'`. |
| connections | `vc_assets` (`vcAssets`) | `vc_number` (as typed), `vc_number_norm` (**stored generated column**), `lifecycle_status` `vc_lifecycle_status` (`in_service\|retired`), timestamps, legacy. **UNIQUE `(operator_id, vc_number_norm)`** (`vc_assets_operator_number_unique`). Whether a VC is in use is not stored: it follows from its assignments. |
| connections | `vc_assignments` (`vcAssignments`) | `vc_asset_id`, `customer_id`, `start_date`, `end_date` (date strings), `status` `assignment_status` (`active\|suspended\|disconnected`), `plan_id` (NULL = custom amount), `rental_amount_paise` ≥ 0, `history_limited` (default false), timestamps, legacy. **`EXCLUDE USING gist (operator_id WITH =, vc_asset_id WITH =, daterange(start_date, end_date, '[]') WITH &&)`** (`vc_assignments_no_overlap`, SQLSTATE 23P01). CHECKs: `end_date ≥ start_date`; `end_date IS NOT NULL ⇔ status = 'disconnected'`. Indexes `(operator_id, customer_id)`, `(operator_id, vc_asset_id, start_date)`, `(operator_id, plan_id)`. |
| connections | `assignment_events` (`assignmentEvents`) | `assignment_id`, `type` `assignment_event_type` (values = `@cb/domain` `ASSIGNMENT_EVENT_TYPES`), `effective_date`, `from_plan_id`/`to_plan_id`/`from_rental_paise`/`to_rental_paise` (rentals required on `plan_changed`, all four NULL on other types), `reason`, `actor_id` (NULL = system/migration), `at`. Partial UNIQUE: one `activated` and one `disconnected` per assignment. **Append-only** for every role. Index `(operator_id, assignment_id, at, id)`. |

**Other database rules** (custom migration `0005`, all CB001 via `app.forbid_update_delete`)

- `customers`, `plans`, `vc_assets`: no DELETE or TRUNCATE (deactivate / retire instead); `id` and
  `operator_id` never change.
- `vc_assignments`: no DELETE or TRUNCATE; `id`, `operator_id`, `vc_asset_id`, `customer_id` and
  `start_date` never change. `status`, `end_date`, `plan_id`, `rental_amount_paise`,
  `history_limited`, `updated_at` and the legacy columns may change.
- `assignment_events`, `customer_contact_changes`: fully append-only.
- Migration `0003` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` (a trusted extension, available on
  Neon) before the tables. `btree_gist` comes from `0000`.

**Normalisation** (decided: stored generated columns, so no write path can skip it; TS twins are
exported for look-ups and friendly errors; tests check that the TS and SQL versions agree on tricky inputs)

- `normalizeCustomerCode(code)`: turn each run of ASCII whitespace into one space, trim, then
  upper-case ASCII `a`–`z`. "0101" ≠ "101"; punctuation and Devanagari are kept as typed.
- `normalizeVcNumber(vc)`: remove all ASCII whitespace and `-`, then upper-case ASCII `a`–`z`, so
  "0001 2345-6789" = "000123456789". `.` and `/` are kept.
- Upper-casing is ASCII-only (`translate`), not `upper()`. `upper()` depends on the database locale,
  and a generated column must give the same value on every server.
- Also exported: `asciiUpper`, `MAX_CODE_LENGTH` (64), `PHONE_PATTERN`, `SQL_ASCII_UPPER_ARGS`, the
  enum arrays `CUSTOMER_STATUSES`, `CONTACT_FIELDS`, `CONTACT_CHANGE_SOURCES`, `PLAN_STATUSES`,
  `VC_LIFECYCLE_STATUSES`, `ASSIGNMENT_STATUSES`, and their types.

**Search indexes** (T-033)

| Index | Type | Serves |
|---|---|---|
| `customers_name_trgm_idx` | GIN `gin_trgm_ops` on `name` | `name % $q`, `similarity(name, $q)` for ranking, `name ILIKE '%…%'` |
| `customers_code_prefix_idx` | btree `(operator_id, customer_code_norm text_pattern_ops)` | code prefix; equality uses the UNIQUE index |
| `customers_phone_idx`, `customers_alt_phone_idx` | btree `(operator_id, phone/alt_phone text_pattern_ops)` | equality and prefix |
| `vc_assets_number_prefix_idx` | btree `(operator_id, vc_number_norm text_pattern_ops)` | VC prefix; equality uses the UNIQUE index |

The test checks that the planner picks each index when the table has 3,000 rows.

**T-040 timeline mapping** (answers T-040 Q-5: `end_date` is the **last day of service, inclusive**,
equal to the disconnection's effective date)

```ts
const timeline: AssignmentTimeline = {
  startDate: businessDate(a.startDate),
  endDate: a.endDate && businessDate(a.endDate),
  events: events /* ORDER BY at, id */.map((e) => e.type === "plan_changed"
    ? { type: e.type, effectiveDate: businessDate(e.effectiveDate), rentalPaise: toPaise(e.toRentalPaise!) }
    : { type: e.type, effectiveDate: businessDate(e.effectiveDate) }),
};
// initialRentalPaise = first plan_changed event's from_rental_paise ?? a.rentalAmountPaise
```

`connections.test.ts` stores this timeline: start 5 Oct, plan change 20 Oct, suspend 10 Nov,
reactivate 3 Dec, disconnect 15 Jan. It reads the rows back, maps them as above and runs
`validateAssignmentTimeline`, `isBillable` (Oct–Feb → no, yes, no, yes, no) and `rentalForPeriod`.

**How later tasks use this**

- **T-023:**
  - `invoice_lines.assignment_id` → `vc_assignments(operator_id, id)`.
  - `adjustments.customer_id` / `assignment_id` → composite FKs to `customers` / `vc_assignments`.
  - `payments.customer_id` and `customer_balances.customer_id` → composite FK to `customers`.
- **T-031 (plans):**
  - Retire and unretire with `status`. Unretiring when an active plan already has the same name
    gives 23505 (`plans_operator_active_name_unique`): show a friendly message.
  - "Connections on this plan" = count of `vc_assignments` where `plan_id` = the plan, using
    `vc_assignments_plan_idx`.
  - Don't assign retired plans to new connections (service rule).
- **T-033 (customers):**
  - Duplicate code: catch 23505 on `customers_operator_code_unique`, or check first with
    `normalizeCustomerCode`.
  - Auto code: `nextCounter(tx, op, "customer_code")`.
  - Before saving a phone, strip it to `^\+?[0-9]{6,19}$`.
  - Write a `customer_contact_changes` row (source `web`) in the same transaction as each
    phone/alt_phone change.
  - Search: use the indexes above. Match VC numbers by joining `vc_assets` → `vc_assignments` on
    `normalizeVcNumber(q)`.
- **T-034 (connections):**
  - **Add:** find or create `vc_assets` by `(operator_id, vc_number_norm)`. Insert `vc_assignments`
    (with `rental_amount_paise` copied from the plan) and an `activated` event on `start_date`.
  - **Suspend / reactivate:** update `status` and insert the matching event.
  - **Disconnect:** set `status = 'disconnected'` and `end_date` = the effective date, and insert a
    `disconnected` event with the same date.
  - **Reuse:** the new assignment's `start_date` must be at least the old `end_date` + 1. Catch 23P01
    `vc_assignments_no_overlap` and show "this VC is still with <customer> until <date>".
  - **Plan change:** update `plan_id` / `rental_amount_paise` and insert `plan_changed` with the
    from/to values.
  - **Service rules the DB does not enforce:** no assignment on a `retired` VC, valid status
    transitions (use T-040 `validateAssignmentTimeline`), and keeping `status` in step with the
    latest event.
- **T-036 (seed):** the triggers block DELETE and TRUNCATE, so reset by recreating the database (or
  the Neon branch), not by truncating.
- **T-044:** load the active and recently ended assignments of a batch of customers with
  `vc_assignments_customer_idx`, plus their events, and map them as above.
- **T-084 (import):** match on `customer_code_norm`, so re-uploading a file updates instead of
  duplicating. Phones must pass the CHECK, so normalise them or report the row.
- **T-092 (migration):**
  - Set `legacy_source` and `legacy_id` (both or neither). UNIQUE
    `(operator_id, legacy_source, legacy_id)` on `customers`, `plans`, `vc_assets` and
    `vc_assignments` makes re-runs idempotent (`ON CONFLICT DO NOTHING`).
  - Import the known current assignment with `history_limited = true`.
  - Some legacy rows can't be stored as they are. Send each one to `migration_exceptions` (BR-14,
    FR-027) and don't invent values:
    - a duplicate code or VC number within an operator;
    - a malformed phone;
    - a disconnected VC with no known end date;
    - a zero start date.

**Decisions (reviewer please check)**

1. **Both date ends inclusive (`'[]'`, PLAN §7.2 literally, same as T-040).** A VC disconnected
   effective D can go to the next customer on D + 1 at the earliest. Same-day reuse (start on D) is
   rejected, because the old customer still has the VC during D. PRD §15 #6 only asks that reuse
   is possible without moving history. See Q-A.
2. The overlap rule covers **every** assignment, including suspended ones (a suspended VC still
   belongs to its customer). Only an `end_date` frees the VC.
3. Normalisation uses **generated columns**, ASCII-only upper-casing, and the rules above. The VC
   rule also removes spaces and `-` (printed grouping). PLAN §7.3 says "trim, upper-case" for
   customer codes; I also collapse inner whitespace runs.
4. **Identity and no-delete triggers** on customers, plans, VC assets and assignments, so history
   (FR-005) can't be overwritten. Corrections are new rows or events.
5. Plan names are unique among **active** plans only, ignoring case and outer spaces.
6. **Phones have a format CHECK** (digits with an optional `+`, 6–19 digits, the same as
   `operators.settings.office_phone`), so FR-019/020 always get a dialable number.
7. `vc_assets.lifecycle_status` is `in_service | retired`. "Assigned" is derived from the
   assignments and not stored, so it can't drift.
8. `assignment_events` has no from/to status columns: the event type already defines the status
   change. Only plan changes carry from/to values, which T-040 needs.
9. A **GIN** trigram index on `name` alone. GIN can't include a uuid column without `btree_gin`, and
   RLS and the `operator_id` predicate filter the rows.

**Open questions**

- **Q-A (affects T-034, the product owner):** should same-day reuse be allowed? Today an operator
  must date the old disconnection one day earlier to install the VC at a new customer on that day.
  Switching to `'[)'` and an exclusive end would change T-040's `endDate` meaning.
- **Q-B (T-033):** pg_trgm only builds trigrams from characters the database locale treats as
  letters or digits. Devanagari vowel signs (matras) are combining marks, so Hindi-script names get
  fewer trigrams. Results are still correct; ranking and index selectivity for Hindi names should be
  checked on Neon's locale with seed data (T-036). Most legacy names are probably Latin script.
- **Q-C:** should a customer's `status = 'inactive'` be blocked while it still has open
  assignments? Today this is left to the service (T-033/T-034).

**Deviations / shared files**

- Tests are in `src/schema/{customers,plans,connections}.test.ts`, next to the modules, as in T-021.
- `src/schema/index.ts`: three appended export lines.
- There are three migrations: `0003` (custom: pg_trgm, which must exist before the GIN index), `0004`
  (generated tables), `0005` (custom: EXCLUDE plus triggers). Drizzle-kit can't express EXCLUDE
  constraints or triggers.
- Added beyond the Scope list: `history_limited` (PLAN §15 / T-092), the per-operator legacy UNIQUE
  indexes, and the one-activation / one-disconnection indexes.
- No other task's files were changed. The `packages/db/README.md` conventions still apply; nothing
  in them changed.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17.11)

- `pnpm --filter @cb/db test`: 15 files, 140 tests, no skips. T-022 adds 49 tests:
  - customers 23: code agreement table, PRD §15 #2, generated column write rejected (428C9), the
    CHECKs, RLS (tenant, platform), composite FK to areas, legacy uniqueness, no delete/truncate and
    identity triggers, trigram search and the planner using each index;
  - contact changes: FR-004 fields, actor rule, append-only, cross-tenant customer/actor FKs, RLS;
  - plans 5: amounts, active-name uniqueness and unretire conflict, no delete, RLS, FR-007 (plan
    edit leaves the copied rental);
  - connections 21: VC agreement table and uniqueness; overlap rejection, same-day reuse rejected,
    next-day reuse accepted with the old assignment unchanged, back-dated and stretched overlaps,
    other assets and other tenants free; CHECKs; identity and no-delete triggers; composite FKs to
    asset, customer and plan; RLS; the T-040 mapping; event CHECKs and partial uniques; append-only;
    cross-tenant event FKs and RLS.
  - The T-020 security audit passes with the new tables.
- **Mutation check** (reverted): with the EXCLUDE range changed to `'[)'`, 2 overlap tests fail
  (same-day reuse, and the range that ends on the open assignment's first day).
- `db:generate` reports "No schema changes"; `db:check` OK.
- Root results after the final rebase: see the PR.

## Board log

- 2026-10-13T12:25:00.767Z claimed by agent-t022
- 2026-10-13T12:37:21.680Z completed on task/T-022-schema-customers-plans-vc-assets-and-ass
