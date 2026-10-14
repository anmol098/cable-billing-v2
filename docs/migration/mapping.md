# Legacy migration: mapping (draft)

| | |
|---|---|
| **Status** | **Draft for review (T-091).** Not signed off. The business signs it off in H-06. |
| **Written from** | The repository only: BRD §10.5, §13, §14; PRD §14, Appendices A and B; PLAN §7, §15, §20; the T-090 tooling and its synthetic fixture; the target schema in `packages/db/src/schema`. |
| **Not yet seen** | The real legacy dump. **Nobody has profiled it yet** (no `docs/migration/profile-*.md` exists). |
| **Next step** | A human with the dump runs the T-090 profiler and query Q0 below, then this document is completed column by column (§12). |

The legacy database holds real customer data (D-09). This document holds **table names, column
names, types, counts and status codes only**. Never paste a row, a name, a phone number, an address,
a login or a password here. Every query below returns counts or aggregates. Run them only on the
staging copy described in [`README.md`](README.md), never in CI.

---

## Contents

1. [How to read this document](#1-how-to-read-this-document)
2. [What is known about the legacy schema](#2-what-is-known-about-the-legacy-schema)
3. [Target model and traceability](#3-target-model-and-traceability)
4. [Rules that apply to every table](#4-rules-that-apply-to-every-table)
5. [Table-by-table mapping](#5-table-by-table-mapping)
6. [Money unit evidence](#6-money-unit-evidence)
7. [`isReceipt` semantics](#7-isreceipt-semantics)
8. [Status code mapping](#8-status-code-mapping)
9. [Date sentinels and time zones](#9-date-sentinels-and-time-zones)
10. [Password hash evidence](#10-password-hash-evidence)
11. [Known limitations](#11-known-limitations)
12. [Completing this document after the first profile](#12-completing-this-document-after-the-first-profile)
13. [Decisions needed from the business (H-06)](#13-decisions-needed-from-the-business-h-06)
14. [Engineering follow-ups](#14-engineering-follow-ups)
15. [Sign-off (H-06)](#15-sign-off-h-06)

---

## 1. How to read this document

Every statement carries one of these evidence labels.

| Label | Meaning |
|---|---|
| **Documented** | Stated in the BRD or PRD (the source of truth). The section is cited. |
| **Inferred** | Follows from documented facts (counts, named relations), but is not stated. Treated as a hypothesis. |
| **Needs dump** | Can only be confirmed against the real dump. The exact query is given. Until it is run, the default in this document is a proposal, not a fact. |

**SQL conventions.** All queries run in Postgres against the raw copy that `legacy:copy` makes
(schema `legacy`, T-090). In that copy:

- table and column names are kept exactly as in MariaDB, so mixed-case names need double quotes
  (`legacy.invoice."isReceipt"`);
- integers are `bigint`, FLOAT/DOUBLE are `double precision`, DECIMAL is `numeric`;
- dates and times are **`text` exactly as MariaDB printed them**, so zero dates (`0000-00-00`)
  are still visible;
- `legacy._copy_columns` lists every column with its MariaDB type, and `legacy._copy_tables`
  lists every table with its row count.

Names in angle brackets, such as `<invoice.amount>`, are **placeholders for column names that are
not known yet**. Replace each one with the real name from query Q0 before running the query.
Where the placeholder stands for a mixed-case name, quote it. Two more assumptions to adjust once
Q0 and Q-R1 are run: the queries treat `"isReceipt"` as `0`/`1`, and they use `op_id` directly on
`invoice` and `vc`; if a table has no `op_id`, join through `costumer` instead.

---

## 2. What is known about the legacy schema

### 2.1 Facts from the documents

| Fact | Label | Source |
|---|---|---|
| The source is MariaDB/MySQL. | Documented | BRD §3, PRD §14 |
| Tables `operator`, `costumer` (spelled this way), `vc`, `invoice`, `ledger`, `lineman`, `plan`, `recharge`, "plus related reference tables". | Documented | BRD §3, §13; PRD §14, App. B |
| Row counts: operator 8, costumer 7,616, vc 7,334, invoice 146,224, ledger 7,334, lineman 134. `plan` and `recharge`: "definition and counts pending". | Documented | BRD §13, PRD App. A |
| `op_id` is the operator identity. Two operators share the display name "ANMOL CABLE NETWORK" and are separate tenants. | Documented | PRD §14 |
| `costumer` has customer codes (duplicates within an operator possible) and a **nullable** operator id. | Documented | BRD §13 |
| `vc` has a customer reference, at least one date column with zero dates, and a status. It is current-state oriented. | Documented | BRD §13, PRD App. B |
| `vc` has balance/due fields related to `ledger`. | Documented | BRD §13 ("relation to VC balance/due fields") |
| `invoice` has a **nullable** customer reference, an `isReceipt` column, an invoice number, and links to `recharge` and `lineman`. | Documented | BRD §3, §13; PRD §14 |
| Invoice amounts are **integer** columns. Ledger amounts are **FLOAT**. | Documented | PRD §14, BRD §3 |
| `lineman` has `isDeleted`, a login, a password and a token. | Documented | BRD §13 ("password/token handling") |
| Per-operator invoice counts once summed to one more than the global count. | Documented | PRD App. A |

### 2.2 Inferences (hypotheses until checked)

| Hypothesis | Why | Check |
|---|---|---|
| H-1. `ledger` has **one row per VC** holding a running balance, not a journal of transactions. | `ledger` and `vc` have exactly the same count (7,334), and the BRD ties ledger amounts to "VC balance/due fields". | Q-L1 |
| H-2. `invoice` mixes **bills** (`isReceipt = 0`) and **payment receipts** (`isReceipt = 1`). | One table, a receipt flag, and a link to `lineman` (linemen collect money; they do not issue bills). 146,224 rows over 7,616 customers is about 19 rows per customer. | §7 |
| H-3. A `recharge` is a per-VC renewal for a period under a plan, and bills are made from recharges. | `invoice` links to `recharge`; `plan` and `recharge` are described together as "reference tables". | Q-X1 |
| H-4. Legacy amounts are in **rupees** (bills in whole rupees, ledger balances in rupees with paise as decimals). | Integer bill amounts plus FLOAT balances is the usual rupee pattern. The BRD forbids assuming the unit from the data type alone (BRD §13), so this must be checked. | §6 |
| H-5. The invoice off-by-one comes from a join, not from the data (for example a duplicated `op_id` in `operator`, or counting through a join on the duplicated operator name). | A plain `GROUP BY op_id` always adds up to the total, so the extra row must come from a join. | Q-O1 |

### 2.3 What is not known

**Every column name** except `op_id`, `isReceipt` and `isDeleted`. The T-090 fixture and the
candidate lists in [`tools/migration/src/config.ts`](../../tools/migration/src/config.ts) are
**guesses** that let the profiler run. They are not evidence and are not used as such here.
Also unknown: the full definitions of `plan` and `recharge`, whether other tables exist, the dump's
character set, and the MariaDB version and time zone of the legacy server.

---

## 3. Target model and traceability

### 3.1 Target tables used by the migration

| Target table | Schema file | Has `legacy_source` / `legacy_id` |
|---|---|---|
| `operators`, `areas` | [`tenancy.ts`](../../packages/db/src/schema/tenancy.ts) | yes |
| `users` (+ Better Auth `accounts`) | [`auth.ts`](../../packages/db/src/schema/auth.ts) | yes (`users`) |
| `customers`, `customer_contact_changes` | [`customers.ts`](../../packages/db/src/schema/customers.ts) | yes (`customers`) |
| `plans` | [`plans.ts`](../../packages/db/src/schema/plans.ts) | yes |
| `vc_assets`, `vc_assignments`, `assignment_events` | [`connections.ts`](../../packages/db/src/schema/connections.ts) | yes (`vc_assets`, `vc_assignments`) |
| `invoices`, `invoice_lines`, `adjustments` | [`billing.ts`](../../packages/db/src/schema/billing.ts) | yes (`invoices`, `adjustments`) |
| `payments`, `payment_reversals` | [`payments.ts`](../../packages/db/src/schema/payments.ts) | yes (`payments`, only when `source = 'migration'`) |
| `receipts` | [`receipts.ts`](../../packages/db/src/schema/receipts.ts) | yes |
| `allocations`, `ledger_entries`, `customer_balances` | [`ledger.ts`](../../packages/db/src/schema/ledger.ts) | no: traced through the invoice, payment or adjustment they reference |
| `subscriptions` | [`subscriptions.ts`](../../packages/db/src/schema/subscriptions.ts) | no: created for each migrated tenant (decision 18) |
| `counters` | [`counters.ts`](../../packages/db/src/schema/counters.ts) | no: legacy numbers do not consume counters (T-093) |

Exports: [`index.ts`](../../packages/db/src/schema/index.ts). Conventions: PLAN §7.1.

`migration_batches`, `migration_exceptions` and `legacy_id_map` are in PLAN §7.2 but **do not
exist in `packages/db` yet** (engineering follow-up F-1).

### 3.2 Traceability convention

- `legacy_source` = the legacy table name, exactly (`costumer`, not `customer`).
- `legacy_id` = the legacy primary key as text. A composite key is joined with `:` in column order.
- Both are set or both are NULL (CHECK on every table). They are unique per operator (partial
  UNIQUE `(operator_id, legacy_source, legacy_id)`), so a re-run cannot insert a row twice.
- One legacy row may produce rows in two target tables (a `vc` row gives a `vc_assets` row and a
  `vc_assignments` row). Both carry the same `legacy_source`/`legacy_id`.
- Rows the migration creates that have no single legacy row (an opening balance) use
  `legacy_source = 'migration:opening'` and `legacy_id` = the legacy customer key.

---

## 4. Rules that apply to every table

1. **Tenant first.** Every row is placed in a tenant through its `op_id` (or through its parent's
   `op_id` when the table has none). A row whose operator is NULL, `0` or not in `operator` is
   not imported and is listed as an exception (`no_operator` / `unknown_operator`). Operators are
   never matched by name (FR-002, PRD §14).
2. **Never merge, never invent** (BR-14, RULE-21). Duplicates become exceptions. Missing facts
   stay missing (NULL) or the row becomes an exception. A default value is used only where a
   decision in §13 approves it, and then the row is still flagged.
3. **Every skipped or changed row is recorded** in the exception register with its source table,
   legacy key, category and reason (FR-026/027). Proposed categories: `no_operator`,
   `unknown_operator`, `null_reference`, `orphan_reference`, `duplicate_code`,
   `duplicate_number`, `duplicate_login`, `blank_required`, `invalid_date`, `invalid_phone`,
   `unknown_status`, `money_rounding`, `money_negative`, `not_migrated_column`.
4. **Text.** Trim leading and trailing spaces. A blank value becomes NULL. The character set must
   be confirmed (Q0b): Hindi text stored as `latin1` would arrive garbled and must be repaired
   before the import, not after.
5. **Money** becomes integer paise (§6). No float reaches the target.
6. **Dates** follow §9. Business dates are `Asia/Kolkata`; instants are stored in UTC.
7. **Append-only targets.** Invoices, payments, receipts, allocations and ledger entries cannot be
   updated after insert. A wrong import is fixed by restoring the Neon branch and re-running, not
   by editing rows.
8. **Column coverage.** A legacy column that is not listed in §5 is not migrated, and the
   transform must refuse to run until it is listed (with a target or a reason). See F-3.

---

## 5. Table-by-table mapping

Each table lists the columns known from the documents, then the columns the documents imply but do
not name ("name unknown"), then a catch-all row for everything else. The catch-all rows are what
§12 replaces with real columns.

### 5.1 `operator` → `operators`

Baseline 8 rows (Documented). One tenant per `op_id`, created by the platform admin through
`provisionTenant` (D-15, T-027) with actor `{ kind: "system", job: "legacy_migration" }`.

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| `op_id` | Documented | `operators.legacy_id` (`legacy_source = 'operator'`) | `op_id::text`. The new `operators.id` is a fresh UUIDv7. All child rows map `op_id` → this id. A duplicated `op_id` in `operator` (Q-O1) stops the import. |
| display name (name unknown) | Documented concept | `operators.name` | Trimmed. Duplicates kept as separate tenants. Blank → exception `blank_required` (decision 17). |
| phone, address (if present) | Needs dump | `operators.phone`, `operators.address` | Trimmed. Not validated by the schema. |
| login / password (if present) | Needs dump | **not migrated** | Owner accounts are created fresh with email verification (decision 17, §10). |
| status / active flag (if present) | Needs dump | **not migrated** as such | `operators.status` is the platform's own suspension flag. Inactive legacy operators: decision 16. |
| all other columns | Needs dump | not migrated until listed | §12. |

Created per tenant without a legacy column: `operators.settings` (defaults from
`DEFAULT_OPERATOR_SETTINGS`, except the values in decision 19) and a `subscriptions` row
(decision 18).

### 5.2 `costumer` → `customers` (+ `areas`)

Baseline 7,616 rows (Documented).

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| primary key (name unknown) | Needs dump | `customers.legacy_id` (`legacy_source = 'costumer'`) | As text. |
| `op_id` (nullable) | Documented | `customers.operator_id` | Via the operator map. NULL / unknown → exception, row not imported (decision 9). |
| customer code (name unknown) | Documented concept | `customers.customer_code` | As typed (trimmed). The database derives `customer_code_norm` (trim, collapse spaces, ASCII upper case). Two rows of one operator with the same normalised code → **both** become `duplicate_code` exceptions; neither is merged (decision 8). Blank → exception. Longer than 64 characters → exception. |
| customer name (name unknown) | Inferred | `customers.name` | Trimmed. Blank → exception `blank_required` (decision 23). |
| mobile / phone columns (names unknown) | Inferred | `customers.phone`, `customers.alt_phone` | Remove spaces, dashes and brackets; keep a leading `+`; a `0`, `91` or `+91` prefix is handled per decision 24. Must match `^\+?[0-9]{6,19}$`; otherwise NULL and an `invalid_phone` exception holding the raw value. No `customer_contact_changes` row: an imported value is the starting value, not a change. |
| address columns (names unknown) | Inferred | `customers.address` | Joined with `, ` if split over several columns. |
| area / locality (if present) | Needs dump | `areas` + `customers.area_id` | One area per operator and distinct value (case-insensitive, trimmed; matches `areas_operator_name_unique`). Missing → `area_id` NULL. Decision 21. |
| status / active / deleted flag (if present) | Needs dump | `customers.status` | §8.2. |
| creation date (if present) | Needs dump | `customers.created_at` | IST date at 00:00 IST → UTC (§9). Invalid → import time, flagged. |
| identity documents / KYC fields (if present) | Needs dump | `customers.kyc` or **not migrated** | Decision 22. |
| balance / due / advance columns (if present) | Needs dump | **not migrated** directly | Used only to reconcile the opening balance (§5.7). |
| all other columns | Needs dump | not migrated until listed | §12. |

### 5.3 `vc` → `vc_assets` + `vc_assignments` (+ `assignment_events`)

Baseline 7,334 rows (Documented). The legacy `vc` row is the **current** state of a VC. It
becomes one asset and at most one assignment, flagged `history_limited = true` (RULE-21,
PLAN §15).

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| primary key (name unknown) | Needs dump | `vc_assets.legacy_id` and `vc_assignments.legacy_id` (`legacy_source = 'vc'`) | As text. |
| `op_id` (or via customer) | Inferred | `operator_id` of both | Via the operator map. If `vc` has no `op_id`, the customer's operator. |
| VC number (name unknown) | Documented concept | `vc_assets.vc_number` | As typed. The database derives `vc_number_norm` (spaces and `-` removed, ASCII upper case). The same normalised number twice in one operator: see Q-V2 and decision 11. |
| customer reference (name unknown) | Documented | `vc_assignments.customer_id` | Via the customer map. NULL, `0` or orphan → the asset is still imported (the number is real) but **no assignment** is created; exception `null_reference` / `orphan_reference`. |
| status (name unknown) | Documented | `vc_assignments.status`, `vc_assets.lifecycle_status` | §8.3. |
| start / activation date (name unknown) | Documented concept (zero dates exist) | `vc_assignments.start_date` | IST date. Zero or invalid → decision 10. |
| disconnection date (if present) | Needs dump | `vc_assignments.end_date` | Only when the mapped status is `disconnected` (CHECK). Missing for a disconnected VC → decision 12. |
| plan reference (if present) | Inferred | `vc_assignments.plan_id` | Via the plan map. NULL means a custom amount. |
| rent / amount (if present) | Inferred | `vc_assignments.rental_amount_paise` | §6. If the VC has no amount of its own, the plan's amount. Neither → exception (decision 1). |
| balance / due fields | Documented | **not migrated** directly | Used to reconcile the opening balance (§5.7). |
| set-top box / card serials, MSO or package codes (if present) | Needs dump | **not migrated** (no target column) | Decision 25. |
| all other columns | Needs dump | not migrated until listed | §12. |

Events written for each imported assignment (T-040 reads status from events, not from the row):
one `activated` event on `start_date`; then, if the mapped status is `suspended`, a `suspended`
event; if `disconnected`, a `disconnected` event on `end_date`. The effective date of a
`suspended` event is unknown unless the dump has one (decision 12). `actor_id` is NULL and
`reason` names the migration.

### 5.4 `plan` → `plans`

Count and definition pending (Documented, BRD §13).

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| primary key (name unknown) | Needs dump | `plans.legacy_id` (`legacy_source = 'plan'`) | As text. |
| `op_id` (if present) | Needs dump | `plans.operator_id` | If plans have no operator (shared by all operators), one copy per operator that uses the plan, each with the same `legacy_id` (decision 20). |
| name (name unknown) | Inferred | `plans.name` | Trimmed. Two **active** plans of one operator with the same name (case- and space-insensitive) violate `plans_operator_active_name_unique`: the second becomes an exception until renamed (decision 20). |
| monthly amount (name unknown) | Inferred | `plans.monthly_amount_paise` | §6. Must be ≥ 0. A plan that is not monthly (quarterly, yearly, a pack price) cannot be mapped as is (decision 20). |
| status / active flag (if present) | Needs dump | `plans.status` | §8.5. |
| all other columns | Needs dump | not migrated until listed | §12. |

### 5.5 `recharge` → to be decided

Count and definition pending (Documented, BRD §13). `invoice` links to it (Documented). Hypothesis
H-3: one row per VC renewal for a period under a plan.

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| every column | Needs dump | **undecided** | Options: (a) use recharges only to attribute legacy bills to a VC and plan (§5.6); (b) also build the plan history of current assignments (`plan_changed` events); (c) keep them in the read-only archive only. Proposal: (a), plus (c) for everything else. Decision 20. |

Check Q-X1 (counts only):

```sql
-- Q-X1: how recharges relate to VCs, plans and bills
SELECT count(*)                                        AS recharges,
       count(DISTINCT r.<recharge.vc>)                 AS distinct_vcs,
       count(DISTINCT r.<recharge.plan>)               AS distinct_plans,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM legacy.invoice i
                                      WHERE i.<invoice.recharge> = r.<recharge.pk>)) AS billed,
       min(r.<recharge.date>) AS first_date, max(r.<recharge.date>) AS last_date
FROM legacy.recharge r;
```

### 5.6 `invoice` → `invoices` (bills) or `payments` + `receipts` (receipts)

Baseline 146,224 rows (Documented). How a row is split depends on `isReceipt` (§7). The mapping
below assumes hypothesis H-2 (0 = bill, 1 = receipt).

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| primary key (name unknown) | Needs dump | `invoices.legacy_id` or `payments.legacy_id` + `receipts.legacy_id` (`legacy_source = 'invoice'`) | As text. |
| `op_id` (if present) | Inferred | `operator_id` | Via the operator map, else through the customer. Disagreement between the two → exception. |
| customer reference (nullable) | Documented | `invoices.customer_id` / `payments.customer_id` | Via the customer map. NULL, `0` or orphan → **not imported**, exception; the amounts are reported separately in the reconciliation (decision 7). |
| `isReceipt` | Documented | selects the target | §7. A value other than the two confirmed ones → exception `unknown_status`. |
| invoice number (name unknown) | Documented | `invoices.invoice_number` / `receipts.receipt_number` | Kept as in legacy (PRD §14). Unique per operator in the target: a repeated number → exception `duplicate_number` (decision 6). Legacy numbers do not consume the new counters. |
| amount (integer) | Documented | `invoices.charges_paise` / `payments.amount_paise` | §6. Bills: `charges_paise ≥ 0`. Receipts: `amount_paise > 0`; zero or negative receipts → exception `money_negative`. |
| date (name unknown) | Inferred | bills: `invoices.period` (1st of the IST month), `invoices.issued_at`; receipts: `payments.recorded_at`, `posted_at`, `business_date` | §9. Invalid → exception. |
| lineman reference | Documented | receipts: `payments.collector_id`; bills: **not migrated** | Via the lineman map. NULL is allowed for migrated payments. |
| recharge reference | Documented | bill attribution only | Finds the VC and plan of a bill line when decision 20 allows it. |
| payment mode / UPI reference (if present) | Needs dump | `payments.method`, `payments.upi_reference` | `method` must be `cash` or `upi`. Unknown mode → decision 13. A UPI reference is kept only for `upi` and stays `unverified` (BR-10). |
| remarks (if present) | Needs dump | `payments.notes` (receipts) / **not migrated** (bills) | Free text, may hold personal data; trimmed. |
| deleted / cancelled flag (if present) | Needs dump | **not imported** as a live document | Listed as an exception; decision 6. |
| all other columns | Needs dump | not migrated until listed | §12. |

How the target rows are built (engineering detail for T-093; the business decides decisions 4–7):

- **Bills.** Target invoices are one per customer and month (`invoices_one_regular_per_period`,
  RULE-05). If the legacy has several bills for one customer in one month (Q-I2), they become **one**
  `regular` invoice for that period: the earliest legacy number becomes `invoice_number` and
  `legacy_id`, and every legacy bill becomes one line carrying its own legacy number in
  `description` (decision 6). Importing the cutover month's legacy bills as `regular` invoices is
  what stops the new billing run from billing that month again (`docs/runbooks/cutover.md` step 7).
- **Bill lines.** A `rent` line needs a `vc_assignments` row of the same customer, and only the
  current assignment is known. A legacy bill for a VC that now belongs to someone else, or that
  cannot be tied to a VC, has no assignment to point at. Proposal: each legacy bill becomes a
  `migration` **debit adjustment** that is invoiced on the migrated invoice as an `adjustment`
  line. This keeps Σ lines = `charges_paise` without inventing assignments, and each adjustment
  carries its own bill's legacy key (`adjustments.legacy_source = 'invoice'`), so no legacy bill
  loses its trace when several are merged into one monthly invoice.
- **Receipts.** Each receipt becomes a `payments` row (`source = 'migration'`, no device, no
  balance snapshots) and a `receipts` row with the legacy number, a `payment` ledger entry, and
  allocations computed with the current rule (oldest bill first, T-041). The legacy system
  probably did not record which bill a receipt paid, so the allocations are **derived**, and the
  reconciliation must say so (§11).

### 5.7 `ledger` → opening balances (reconciliation only)

Baseline 7,334 rows (Documented). Amounts are FLOAT (Documented). Under hypothesis H-1 a ledger row
is a VC's current balance, not a transaction, so **no ledger row is copied** into
`ledger_entries` (the target ledger is a journal of the documents imported in §5.6).

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| primary key (name unknown) | Needs dump | `legacy_id` of the opening balance (via `legacy_source = 'migration:opening'`, keyed by customer) | Listed per customer in the reconciliation report. |
| VC / customer reference (name unknown) | Inferred | the customer | Via `vc` → customer. Orphans → exception. |
| balance / due amount (FLOAT) | Documented | opening balance per customer | Σ over the customer's VCs, rounded to paise (§6). |
| all other columns | Needs dump | not migrated until listed | §12. |

Opening balance per customer, at cutover:

```text
difference = legacy due (from ledger, decision 4) − (Σ imported bill charges − Σ imported receipts)
difference > 0  → one invoice kind = 'opening_balance', charges = difference, ledger entry 'opening_balance'
difference < 0  → one adjustment source = 'migration', direction = 'credit', amount = −difference,
                  ledger entry 'credit_adjustment' (applied to open bills oldest first)
difference = 0  → nothing
```

The schema requires this split: an `opening_balance` ledger entry must be ≥ 0, and an adjustment
amount must be > 0. Every non-zero difference is listed in the reconciliation report with its
reason. If the business imports no bill/receipt history (decision 5, option b), the whole legacy
due becomes the opening balance.

```sql
-- Q-L1: is ledger one row per VC? (H-1)
SELECT count(*)                                AS ledger_rows,
       count(DISTINCT l.<ledger.vc>)           AS distinct_vcs,
       count(*) FILTER (WHERE v.<vc.pk> IS NULL) AS orphan_rows
FROM legacy.ledger l
LEFT JOIN legacy.vc v ON v.<vc.pk> = l.<ledger.vc>;
-- H-1 holds if ledger_rows = distinct_vcs = 7,334 and orphan_rows = 0.
```

### 5.8 `lineman` → `users` (role `lineman`)

Baseline 134 rows (Documented).

| Legacy column | Label | Target | Transform / rule |
|---|---|---|---|
| primary key (name unknown) | Needs dump | `users.legacy_id` (`legacy_source = 'lineman'`) | As text. |
| `op_id` | Documented (tenant mapping) | `users.operator_id` | Via the operator map. NULL / unknown → exception. |
| name (name unknown) | Inferred | `users.name` | Trimmed. Blank → exception. |
| login (name unknown) | Documented | `users.login`, `users.display_login` | `login` = lower case, no spaces, 3–100 characters, **unique across the whole platform** (all tenants and sign-up users). Collisions or invalid logins → exception `duplicate_login` (decision 15). `display_login` = as typed. |
| password | Documented | **not migrated** | No `accounts` credential is created. The Owner sets a new password in Settings → Team before the lineman's first sign-in (§10, decision 14). |
| token | Documented | **not migrated** | Legacy sessions end at cutover. The new app issues its own tokens (T-028). |
| `isDeleted` | Documented | `users.status` | §8.4. Deleted linemen are still imported (as `disabled`), because migrated receipts name them as collectors (decision 16). |
| phone (if present) | Needs dump | `users.phone` | Same normalisation as customer phones. |
| all other columns | Needs dump | not migrated until listed | §12. |

Fixed values: `role = 'lineman'`, `language` = the operator's `default_language` (`hi` by
default, D-06), `email` NULL.

### 5.9 Other tables in the dump

The BRD mentions "related reference tables" without naming them. Any table found by Q0 that is not
in §5.1–5.8 is **not migrated** until it is added here with a target or a reason. Expected kinds and
their default:

| Kind of table | Default |
|---|---|
| Lookups (areas, plan types, status names) | Read to translate codes (§8); not migrated as tables. |
| Logs, sessions, tokens, OTPs, SMS queues | Not migrated: no business history, and they hold secrets. |
| Application settings | Read to fill `operators.settings` where they match (decision 19); otherwise not migrated. |

---

## 6. Money unit evidence

**Target.** Integer paise in `bigint *_paise` columns (D-17, PLAN §7.1). The UI shows whole rupees.

**Evidence so far.** Bill amounts are integers and ledger amounts are FLOAT (Documented). Nothing
else is known. The BRD forbids deciding the unit from the type alone (BRD §13).

**Hypothesis H-4:** amounts are rupees. Bills are whole rupees; ledger balances may carry paise as
decimals.

**Checks (needs dump).** The profile's section 6 counts whole-hundred and fractional values per
money column. Then run:

```sql
-- Q-M1: bill and receipt amounts (H-4)
SELECT "isReceipt",
       count(*)                                             AS rows,
       count(*) FILTER (WHERE <invoice.amount> = 0)         AS zero,
       count(*) FILTER (WHERE <invoice.amount> < 0)         AS negative,
       count(*) FILTER (WHERE <invoice.amount> % 10 = 0)    AS multiple_of_10,
       count(*) FILTER (WHERE <invoice.amount> % 100 = 0)   AS multiple_of_100,
       percentile_disc(ARRAY[0.05, 0.5, 0.95]) WITHIN GROUP (ORDER BY <invoice.amount>) AS p5_p50_p95,
       max(<invoice.amount>)                                AS max
FROM legacy.invoice
GROUP BY "isReceipt"
ORDER BY 1;

-- Q-M2: plan amounts, for comparison with Q-M1
SELECT count(*), percentile_disc(ARRAY[0.05, 0.5, 0.95]) WITHIN GROUP (ORDER BY <plan.amount>)
FROM legacy.plan;

-- Q-M3: ledger floats: fractions, sub-paisa values, and possible precision loss in the dump
SELECT abs(<ledger.amount>) >= 10000                                         AS large,
       count(*)                                                              AS rows,
       count(*) FILTER (WHERE <ledger.amount> <> trunc(<ledger.amount>))     AS with_decimals,
       count(*) FILTER (WHERE abs(<ledger.amount> * 100
                                  - round(<ledger.amount> * 100)) > 1e-6)    AS finer_than_paisa,
       min(<ledger.amount>), max(<ledger.amount>)
FROM legacy.ledger
GROUP BY 1;

-- Q-M4: does ledger = bills − receipts per customer, and in which unit and sign? (H-1, H-2, H-4)
WITH inv AS (
  SELECT <invoice.customer> AS customer,
         coalesce(sum(<invoice.amount>) FILTER (WHERE "isReceipt" = 0), 0) AS billed,
         coalesce(sum(<invoice.amount>) FILTER (WHERE "isReceipt" = 1), 0) AS received
  FROM legacy.invoice
  WHERE <invoice.customer> IS NOT NULL
  GROUP BY 1),
led AS (
  SELECT v.<vc.customer> AS customer, sum(l.<ledger.amount>) AS balance
  FROM legacy.ledger l JOIN legacy.vc v ON v.<vc.pk> = l.<ledger.vc>
  GROUP BY 1)
SELECT count(*)                                                                    AS customers,
       count(*) FILTER (WHERE abs(billed - received - balance) < 1)               AS same_unit_same_sign,
       count(*) FILTER (WHERE abs(billed - received + balance) < 1)               AS same_unit_opposite_sign,
       count(*) FILTER (WHERE abs(billed - received - balance * 100) < 100)       AS ledger_100x_smaller,
       count(*) FILTER (WHERE abs((billed - received) * 100 - balance) < 100)     AS ledger_100x_larger
FROM inv JOIN led USING (customer);
```

**How to read the results.**

- Rupees: Q-M1's median bill is in the same range as Q-M2's plan amounts and as the rents the
  operators charge today (the business confirms, decision 1). Most bills are multiples of 10.
- Paise: the medians are 100 times the rents, and almost every amount is a multiple of 100.
- Q-M4: the column with the most matches gives both the unit relation and the sign convention of
  the ledger. If no column matches most customers, the ledger is not "bills minus receipts", and
  decision 4 must choose which figure is authoritative.
- MariaDB `FLOAT` is single precision (about 7 significant digits), and MariaDB may print it with
  fewer digits in query results and in `mysqldump` output. If Q-M3 shows decimals on small
  balances but **none** on large ones, the dump has probably lost the paise of large balances.
  The column type is in `legacy._copy_columns.source_column_type` (`float` vs `double`).

**Transform (proposal, pending decisions 1 and 2).**

- Integer rupees → paise: `amount * 100`.
- FLOAT rupees → paise: `round(amount::numeric * 100)`. Postgres rounds `numeric` half away from
  zero. Every value with `finer_than_paisa` is listed as a `money_rounding` exception with its
  rounding difference.
- Tolerance (Q-08, default ±₹1 per customer with an explained list): decision 2.

---

## 7. `isReceipt` semantics

**Evidence so far.** The column exists on `invoice`, and the BRD lists "isReceipt semantics" as a
review item (Documented). Its values and meaning are not documented.

**Hypotheses.**

| | Meaning | What the data would show |
|---|---|---|
| H-2a (proposed) | The row records **money received**: 1 = payment receipt, 0 = bill. | Receipt rows mostly have a lineman; bill rows mostly do not. Receipt amounts are irregular (part payments); bill amounts match plan rents. Q-M4 matches with "bills − receipts". |
| H-2b | The row is always a bill; 1 = a receipt was issued for it (the bill is paid). | Lineman and recharge links look alike in both groups; every receipt row's amount equals a plan rent; Q-M4 does not match "bills − receipts". |
| H-2c | Something else (a print flag, a document type with more values). | More than two values, or neither pattern above. |

**Check (needs dump).**

```sql
-- Q-R1: the two groups side by side
SELECT "isReceipt",
       count(*)                                  AS rows,
       count(<invoice.customer>)                 AS with_customer,
       count(<invoice.lineman>)                  AS with_lineman,
       count(<invoice.recharge>)                 AS with_recharge,
       count(DISTINCT <invoice.number>)          AS distinct_numbers,
       sum(<invoice.amount>)                     AS amount_total
FROM legacy.invoice
GROUP BY 1
ORDER BY 1;

-- Q-R2: share of rows whose amount equals a plan amount (bills should, part payments should not)
SELECT i."isReceipt",
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM legacy.plan p
                                      WHERE p.<plan.amount> = i.<invoice.amount>)) AS equals_a_plan_amount,
       count(*) AS rows
FROM legacy.invoice i
GROUP BY 1
ORDER BY 1;
```

Also read Q-M4. **Mapping under H-2a:** 0 → bill (§5.6 "Bills"), 1 → receipt (§5.6 "Receipts").
Under H-2b, only bills are migrated from `invoice`, and receipts and payments must come from
somewhere else (another table or the ledger), which changes §5.6 and §5.7. Decision 3.

---

## 8. Status code mapping

The legacy status values are unknown. The profile's section 7 lists the distinct values of every
status-like column (codes only; values used by fewer than 5 rows are counted, not shown). For each
column, fill in the table with the business (decision 10). Any value without a row here becomes an
`unknown_status` exception.

```sql
-- Q-S1: distinct values of one status column (run per column; paste only code-like values)
SELECT <table.status> AS value, count(*) AS rows
FROM legacy.<table>
GROUP BY 1
ORDER BY 2 DESC;

-- Q-S2: which tables have a deleted/active/status flag
SELECT table_name, column_name, source_column_type
FROM legacy._copy_columns
WHERE lower(column_name) ~ '(deleted|active|status|state|enabled|closed|cancel)'
ORDER BY 1, 2;
```

### 8.1 `operator` status → (not mapped)

| Legacy value | Meaning (business) | Target |
|---|---|---|
| _from profile_ | | Live operators are migrated (`operators.status = 'active'`). Closed ones: decision 16. |

### 8.2 `costumer` status → `customers.status`

| Legacy value | Meaning (business) | Target |
|---|---|---|
| _from profile_ | active / paying | `active` |
| _from profile_ | left, closed, deleted | `inactive` |

### 8.3 `vc` status → `vc_assignments.status` and `vc_assets.lifecycle_status`

| Legacy value | Meaning (business) | `vc_assignments.status` | `vc_assets.lifecycle_status` |
|---|---|---|---|
| _from profile_ | in service, billed monthly | `active` | `in_service` |
| _from profile_ | temporarily stopped; may restart | `suspended` (rent stops from the next month, D-14) | `in_service` |
| _from profile_ | disconnected; card can be reused | `disconnected` (needs `end_date`) | `in_service` |
| _from profile_ | card lost, damaged or returned | `disconnected` (needs `end_date`) | `retired` |

```sql
-- Q-S3: VC status against what the legacy system actually did last month
SELECT v.<vc.status> AS status,
       count(*)      AS vcs,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM legacy.invoice i
         WHERE i.<invoice.customer> = v.<vc.customer> AND i."isReceipt" = 0
           AND i.<invoice.date> >= '<first day of the last legacy month>')) AS customer_billed_last_month
FROM legacy.vc v
GROUP BY 1
ORDER BY 2 DESC;
```

### 8.4 `lineman.isDeleted` → `users.status`

| Legacy value | Meaning | Target |
|---|---|---|
| `0` (expected) | current lineman | `active` |
| `1` (expected) | removed lineman | `disabled` (kept: historic receipts name them) |

```sql
-- Q-S4: isDeleted values and how many receipts each group collected
SELECT l."isDeleted",
       count(DISTINCT l.<lineman.pk>) AS linemen,
       count(i.<invoice.pk>)          AS invoice_rows
FROM legacy.lineman l
LEFT JOIN legacy.invoice i ON i.<invoice.lineman> = l.<lineman.pk>
GROUP BY 1
ORDER BY 1;
```

### 8.5 `plan` status → `plans.status`

| Legacy value | Meaning (business) | Target |
|---|---|---|
| _from profile_ | offered to new connections | `active` |
| _from profile_ | no longer offered | `retired` |

A plan referenced only by disconnected VCs or old recharges is imported as `retired`.

### 8.6 `invoice.isReceipt`

See §7.

---

## 9. Date sentinels and time zones

**Evidence so far.** `vc` has zero dates (Documented). The PRD requires zero dates to become
"explicit unknown/null plus migration exception" (PRD §14). The T-090 copy keeps dates as text, and
the profile's section 5 counts zero dates, invalid dates (such as `2019-00-10`) and the earliest and
latest valid value per date column.

**Sentinels handled.**

| Value (text in the copy) | Meaning | Transform |
|---|---|---|
| `0000-00-00`, `0000-00-00 00:00:00` | MariaDB zero date: "no date" | NULL + `invalid_date` exception |
| a zero month or day (`2019-00-10`, `2019-05-00`) | partial date | NULL + `invalid_date` exception |
| an impossible date (`2019-02-30`) | invalid | NULL + `invalid_date` exception |
| `1970-01-01`, `1900-01-01`, `9999-12-31`, `2038-01-19` | common "no value" placeholders | treated as sentinels **only if the profile shows them in bulk**; otherwise imported as dates and listed |
| a date after the dump date | future (typing error, or a planned date) | imported as is only where the target allows it; listed |

```sql
-- Q-D1: sentinel and invalid values in one date column (Postgres 16+ for pg_input_is_valid)
SELECT <table.date_col> AS value, count(*) AS rows
FROM legacy.<table>
WHERE <table.date_col> IS NOT NULL
  AND (   substr(<table.date_col>, 1, 4) = '0000'
       OR substr(<table.date_col>, 6, 2) = '00'
       OR substr(<table.date_col>, 9, 2) = '00'
       OR NOT pg_input_is_valid(<table.date_col>, 'timestamp')
       OR substr(<table.date_col>, 1, 10) IN ('1970-01-01', '1900-01-01', '9999-12-31', '2038-01-19')
       OR substr(<table.date_col>, 1, 10) > '<dump date YYYY-MM-DD>')
GROUP BY 1
ORDER BY 2 DESC;
-- Do not run this on a date-of-birth column: its values are personal data.
```

**Where a NULL is not allowed in the target**, the row needs decision 10 or becomes an exception:
`vc_assignments.start_date`, `invoices.period` and `issued_at`, `payments.recorded_at`,
`posted_at` and `business_date`, `assignment_events.effective_date`.

**Time zones (needs dump).**

- MariaDB `DATE` and `DATETIME` store no time zone. Proposal: they are Indian local time.
  A `DATE` is an IST business date as is. A `DATETIME` becomes UTC with
  `(<text>)::timestamp AT TIME ZONE 'Asia/Kolkata'`.
- MariaDB `TIMESTAMP` is stored in UTC and printed in the session time zone. `mysqldump` writes
  `SET TIME_ZONE='+00:00'` at the top by default, so the restore keeps the instants. The copy then
  prints them in the staging server's time zone (the `mariadb:10.11` image runs in UTC unless
  configured otherwise).
- Checks: `SELECT table_name, column_name, source_data_type FROM legacy._copy_columns WHERE
  source_data_type IN ('date', 'datetime', 'timestamp', 'time', 'year') ORDER BY 1, 2;`, and on the
  staging MariaDB `SELECT @@global.time_zone, @@system_time_zone;`. Read the dump's first lines
  for `TIME_ZONE`.
- **Periods.** A bill's period is the 1st of its IST month (`CHECK (extract(day from period) = 1)`).
  Which legacy date gives the period (bill date, or a "for month" column) is decided after Q0.

---

## 10. Password hash evidence

**Evidence so far.** `lineman` holds passwords and tokens (Documented). Their format is unknown.
The PRD forbids carrying plaintext and requires the algorithm to be verified, otherwise a reset
(FR-028, PRD §14). The target hashes with argon2id through Better Auth
([`packages/core/src/auth/password.ts`](../../packages/core/src/auth/password.ts)), and its
verifier rejects any stored hash that does not start with `$argon2`.

**Check (needs dump).** It counts shapes only and never shows a value.

```sql
-- Q-P1: password shapes in lineman (repeat for operator if it has a password column)
SELECT CASE
         WHEN <lineman.password> IS NULL OR <lineman.password> = ''         THEN 'empty'
         WHEN <lineman.password> ~ '^\$2[abxy]\$[0-9]{2}\$.{53}$'          THEN 'bcrypt'
         WHEN <lineman.password> ~ '^\$argon2(id|i|d)\$'                   THEN 'argon2'
         WHEN <lineman.password> ~ '^\$[156]\$'                            THEN 'crypt md5/sha256/sha512'
         WHEN <lineman.password> ~ '^\$[PH]\$'                             THEN 'phpass'
         WHEN <lineman.password> ~ '^\*[0-9A-F]{40}$'                      THEN 'MySQL PASSWORD()'
         WHEN <lineman.password> ~ '^[0-9a-fA-F]{32}$'                     THEN '32 hex (md5?)'
         WHEN <lineman.password> ~ '^[0-9a-fA-F]{40}$'                     THEN '40 hex (sha1?)'
         WHEN <lineman.password> ~ '^[0-9a-fA-F]{64}$'                     THEN '64 hex (sha256?)'
         ELSE 'other: possibly plaintext or reversible encoding'
       END                                  AS shape,
       count(*)                             AS rows,
       min(length(<lineman.password>))      AS min_len,
       max(length(<lineman.password>))      AS max_len
FROM legacy.lineman
GROUP BY 1
ORDER BY 2 DESC;

-- Q-P2: unsalted hashes repeat for equal passwords
SELECT count(*) AS rows, count(DISTINCT <lineman.password>) AS distinct_values FROM legacy.lineman;
```

A shape is a hint, not proof: a 32-character hex value could be MD5, an MD5 of a salted string, or
a random token. Proof needs the legacy application's source code (the function that writes the
column) or its developer.

**Proposal (decision 14):** whatever Q-P1 shows, do **not** carry legacy password hashes. Every
migrated lineman gets a new password from the Owner in Settings → Team before cutover (the cutover
runbook already plans this: `docs/runbooks/cutover.md` §3 step 2). Reasons: there are only 134
linemen; each must sign in once on the new app anyway (D-07); MD5/SHA-1/plaintext would weaken
the new system; and supporting a second verifier adds security-sensitive code for one-time use.
Tokens are never migrated.

---

## 11. Known limitations

These are facts the legacy data cannot give. The migration does not invent them (RULE-21, BR-14),
and the business signs them as known limitations before cutover (PRD §14).

1. **Assignment history.** `vc` holds only the current customer of each VC (PRD App. B). Earlier
   holders of a reused VC, and the dates it moved, are unknown. Each VC gets at most one assignment
   (`history_limited = true`). A legacy bill for a VC that later moved stays with the customer it
   was billed to, but cannot be tied to the VC assignment it was for (§5.6 "Bill lines").
2. **Status history.** Only the current status of a VC is known. Past suspensions, reactivations
   and disconnections (and their effective dates) are unknown unless the dump has dated columns
   for them. Only the events in §5.3 are written.
3. **Plan and rent history.** Only the current plan and rent are known, unless `recharge` carries
   them per period (decision 20).
4. **Which bill a receipt paid.** Probably not recorded in the legacy system (needs dump). The
   target computes allocations oldest-first; these are derived, not historical facts.
5. **Payment method.** Cash and UPI may not be separated in legacy receipts (decision 13).
6. **Who collected.** Receipts without a lineman reference have no collector
   (`payments.collector_id` NULL is allowed for migrated payments).
7. **Bills and receipts without a customer.** They cannot be attached to an account (decision 7).
   Their totals are reported per operator.
8. **Precision.** FLOAT balances may differ from exact paise, and the dump may have rounded large
   values (§6). Differences within the agreed tolerance are listed, not hidden.
9. **Balances by VC.** The target keeps one balance per customer. A per-VC legacy balance is summed
   per customer and is not visible per VC afterwards.
10. **Legacy-only data.** Columns marked "not migrated" stay only in the read-only legacy copy kept
    after cutover (Q-07, default 12 months).

---

## 12. Completing this document after the first profile

1. Run the T-090 tooling on the real dump (`docs/migration/README.md`) and commit the counts-only
   profile `docs/migration/profile-<date>.md`.
2. Run Q0 and paste the result into §5 (names and types only):

   ```sql
   -- Q0: every legacy table and column (no data)
   SELECT c.table_name, c.ordinal, c.column_name, c.source_column_type, c.nullable, c.primary_key,
          t.source_rows
   FROM legacy._copy_columns c
   JOIN legacy._copy_tables t USING (table_name)
   ORDER BY c.table_name, c.ordinal;

   -- Q0b: character sets (run on the staging MariaDB)
   SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = 'legacy' AND CHARACTER_SET_NAME IS NOT NULL
   ORDER BY 1, 2;
   ```

3. Replace every "name unknown" row with the real column, and every catch-all row with one row per
   remaining column (target, or "not migrated" and why).
4. Run the checks Q-O1, Q-X1, Q-L1, Q-M1–4, Q-R1–2, Q-S1–4, Q-D1, Q-P1–2, Q-I1–2, Q-V1–2 and
   record the aggregates and the resulting decision next to each section. Then remove the
   "Needs dump" label where a check settled the question.
5. Put the real column names first in the candidate lists in
   [`tools/migration/src/config.ts`](../../tools/migration/src/config.ts), re-run the profile, and
   confirm the reference and duplicate checks say "checked" (T-090 follow-up).
6. Give the business the decisions list (§13) for H-06.

The remaining checks named above:

```sql
-- Q-O1: the invoice off-by-one (H-5)
SELECT (SELECT count(*) FROM legacy.invoice)                                       AS invoices,
       (SELECT count(*) FROM legacy.operator)                                      AS operator_rows,
       (SELECT count(DISTINCT op_id) FROM legacy.operator)                         AS distinct_op_ids,
       (SELECT count(*) FROM legacy.invoice i JOIN legacy.operator o USING (op_id)) AS invoices_joined_to_operator,
       (SELECT count(*) FROM legacy.invoice i
          JOIN legacy.costumer c ON c.<costumer.pk> = i.<invoice.customer>)        AS invoices_joined_to_customer;
-- (if invoice has no op_id, group through costumer instead)

-- Q-I1: invoice numbers repeated within an operator, by isReceipt
SELECT "isReceipt", count(*) AS repeated_numbers, sum(n) AS rows_involved
FROM (SELECT op_id, "isReceipt", <invoice.number>, count(*) AS n
      FROM legacy.invoice GROUP BY 1, 2, 3 HAVING count(*) > 1) d
GROUP BY 1;

-- Q-I2: bills per customer per month (RULE-05: the target allows one regular invoice per month)
SELECT n AS bills_in_month, count(*) AS customer_months
FROM (SELECT <invoice.customer>, substr(<invoice.date>, 1, 7) AS month, count(*) AS n
      FROM legacy.invoice
      WHERE "isReceipt" = 0 AND <invoice.customer> IS NOT NULL
      GROUP BY 1, 2) t
GROUP BY n
ORDER BY n;

-- Q-V1: customers per VC number within an operator (current-state check)
SELECT count(*) AS vc_rows,
       count(DISTINCT (op_id, <vc.number>)) AS distinct_numbers,
       count(*) FILTER (WHERE <vc.customer> IS NULL OR <vc.customer> = 0) AS without_customer
FROM legacy.vc;

-- Q-V2: repeated VC numbers: same customer, or different customers (a reuse trail)?
SELECT count(*) AS repeated_numbers,
       count(*) FILTER (WHERE customers = 1) AS same_customer,
       count(*) FILTER (WHERE customers > 1) AS different_customers
FROM (SELECT op_id, <vc.number>, count(DISTINCT <vc.customer>) AS customers
      FROM legacy.vc GROUP BY 1, 2 HAVING count(*) > 1) d;
```

---

## 13. Decisions needed from the business (H-06)

Each decision has a proposed default. The default applies to rehearsals until the business answers.
The final import (H-09) waits for every answer.

| # | Decision | Proposed default | Blocks |
|---|---|---|---|
| 1 | **Money unit.** Are legacy bill amounts and ledger balances in rupees? What do operators charge per connection today (a range is enough to check Q-M1)? | Rupees, if Q-M1 to Q-M4 agree | every amount |
| 2 | **Rounding and tolerance (Q-08).** Round FLOAT balances half away from zero to the paisa. Tolerance per customer and per operator. | ±₹1 per customer, every difference listed | reconciliation sign-off |
| 3 | **`isReceipt`.** Does 1 mean "money received" and 0 "bill"? | H-2a (1 = receipt) | §5.6 |
| 4 | **Which balance is right at cutover.** The legacy ledger balance (what customers and linemen know), or bills minus receipts recomputed from history? | The legacy ledger balance; the difference becomes an opening balance or a migration credit, listed per customer | opening balances |
| 5 | **How much history to import.** (a) all bills and receipts, (b) none (opening balances only, history in the archive), or (c) from a start month. Also: the last month billed by the legacy system, so the new system starts billing the month after. | (a) all, if Q-M4 reconciles; else (c) | volume, cutover month |
| 6 | **Bill and receipt numbers.** Several legacy bills for one customer in one month become one invoice with one line per bill, keeping every legacy number on its line. Repeated numbers within an operator and cancelled/deleted bills: import or list only? | Merge per month; repeats and cancelled rows go to exceptions | §5.6 |
| 7 | **Bills or receipts without a customer.** Leave them out of the new system and report their totals per operator, or attach them somehow? | Leave out and report (attaching would invent facts) | reconciliation |
| 8 | **Duplicate customer codes within one operator.** The operator chooses new codes (for example `101` and `101-B`) before the final import, or names which record is current. | Exceptions until the operator decides; never merged | customers |
| 9 | **Customers with no operator.** Assign each to an operator, or leave them out? | Leave out and list | customers |
| 10 | **Status meanings and unknown start dates.** Fill the tables in §8 for each status column. For a VC with no valid start date: the earliest legacy bill month, the customer's creation date, or the cutover date? | Earliest legacy bill month, flagged; else cutover date, flagged | VCs |
| 11 | **Repeated VC numbers within an operator.** If Q-V2 finds the same card under two customers, which one holds it now? | Exceptions until the operator decides | VCs |
| 12 | **Disconnected and suspended VCs.** Import disconnected VCs (as closed assignments, needs an end date) or only live ones? What end date when none is recorded? When did a suspension start? | Import them; missing end date = the last legacy bill month's last day, flagged | VCs, billing |
| 13 | **Payment method of legacy receipts.** If legacy receipts do not say cash or UPI: record them as cash, or add a separate "not recorded" method (a schema change; reports would show a third total)? | Ask; no default, because either answer changes cash totals | receipts |
| 14 | **Lineman passwords.** Accept that no legacy password is carried over, and that Owners set new ones before cutover. | Yes (§10) | linemen |
| 15 | **Lineman logins.** Logins must be unique across all operators. Keep legacy logins where possible; where two collide, use the lineman's mobile number? | Keep if unique; else the mobile number; else the Owner chooses | linemen |
| 16 | **Removed linemen and closed operators.** Import deleted linemen as disabled users (they appear on old receipts)? Migrate operators that are no longer active? | Linemen: yes, disabled. Operators: only those still operating | users, tenants |
| 17 | **Owners of migrated operators.** Who is the Owner of each of the 8 operators (name, mobile, email for sign-in)? These are probably not in the legacy data. | The platform admin collects them before the rehearsal | tenants |
| 18 | **Subscription for migrated operators.** Do they get the 30-day trial (D-20), a different start, or a manual extension? From when does the ₹400 + GST fee apply? | Trial starts at go-live | subscriptions |
| 19 | **Operator settings.** For each operator: mid-month start policy (D-18), invoice prefix, receipt footer, office phone, default language. | `start_next_month`, `INV`, none, none, `hi` | settings |
| 20 | **`plan` and `recharge`.** What is a recharge? Must recharge history be visible in the new app, or is the archive enough? Are plans per operator or shared? Are any plans not monthly? Two live plans with the same name: which name changes? | Recharges used only to attribute bills; plans copied per operator; non-monthly plans are exceptions | plans, bills |
| 21 | **Areas.** If customers have an area or locality, use it as the new "area"? | Yes, one area per distinct value | customers |
| 22 | **ID documents (KYC).** If the legacy data has Aadhaar or other ID numbers, carry them over or leave them in the archive? | Leave in the archive (less personal data to protect) | customers |
| 23 | **Customers with no name.** Use the customer code as the name, or list them for the operator to fix? | List them; nothing invented | customers |
| 24 | **Phone numbers.** Invalid numbers are dropped with an exception. Keep a leading `0` or `91` as typed, or store numbers as 10 digits? | 10 digits when a `0`/`91`/`+91` prefix is clearly present; otherwise as typed | customers, receipts |
| 25 | **Legacy-only fields.** Set-top box numbers, MSO or package codes, remarks: needed in the new app, or archive only? | Archive only, unless named here | customers, VCs |
| 26 | **Opening balance shown to customers.** What the opening balance bill is called and numbered, and which month it belongs to. | "Old dues", numbered `{prefix}-OB-{legacy customer key}`, period = the cutover month | statements, receipts |
| 27 | **Legacy archive (Q-07).** How long the read-only legacy copy is kept, and who may look at it for disputes. | 12 months; Owner requests through the platform admin | cutover |

---

## 14. Engineering follow-ups

Not business decisions. For T-092 to T-094 unless noted.

| # | Follow-up | Owner |
|---|---|---|
| F-1 | `migration_batches`, `migration_exceptions` and `legacy_id_map` (PLAN §7.2) do not exist in `packages/db` yet. They must be added (T-092 scope: "legacy_id_map + migration_exceptions"). | T-092 |
| F-2 | A migrated lineman has a `users` row but no credential in `accounts`. Check that Settings → Team "reset password" (T-032) works for a user with no credential yet; if not, add it. | T-092 |
| F-3 | Column coverage guard: the transforms refuse to run when `legacy._copy_columns` has a column this document does not list. Keeps the acceptance criterion true after the real columns arrive. | T-092 |
| F-4 | Put the real column names first in `tools/migration/src/config.ts` and check the sensitive-column classifier covers every personal column (T-090 follow-up). | after the first profile |
| F-5 | `payments.method` allows only `cash`/`upi`. Decision 13 may need a migration-only value, which touches reports (RULE-14). | T-093, if decided |
| F-6 | Opening balances: `opening_balance` ledger entries must be ≥ 0 and adjustments > 0, so a legacy credit becomes a `migration` credit adjustment (§5.7). | T-093 |
| F-7 | Legacy bills attached as `migration` debit adjustments invoiced on the migrated invoice (§5.6), because `rent` lines require an assignment of the same customer. Run the nightly invariants (T-052) on the imported data. | T-093 |
| F-8 | Allocations of migrated receipts are computed with T-041 oldest-first and must be labelled "derived" in the reconciliation report. | T-093, T-094 |
| F-9 | The queries were checked once (T-091) on Postgres 17 against a scratch `legacy` schema with stand-in column names and a few fake rows: they all run. Each must be re-checked after the placeholders are replaced with the real names. | whoever runs §12 |

---

## 15. Sign-off (H-06)

To be completed by the business. Record answers in §13 (replace "Proposed default" with the
decision) and sign here.

| Role | Name | Date | Signature / approval reference |
|---|---|---|---|
| Business owner | | | |
| Finance owner | | | |
| Engineering | | | |
