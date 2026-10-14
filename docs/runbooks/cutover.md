# Runbook: production cutover from the legacy system

Who this is for: the cutover lead (engineering), the business owner and the migration lead. Draft by
T-096; the human task **H-09** owns this file and fills in the blanks (marked `____`) once the
migration tools (T-092, T-093, T-094) and the admin console (T-086) exist. Background: BRD §10.5 and
§17, PRD §14 and §15 #13–14, PLAN §15 step 6 and §18 Phase 6, Q-07, Q-08.

The legacy dump and anything copied from it hold real customer data: never in git, a chat, a ticket or
CI (D-09). Work only on the machines named in `docs/migration/README.md`.

---

## 1. Go / no-go checklist (one week before, again on the day)

Every line needs a name and a date. A missing line is a **no-go**.

| # | Check | Evidence |
|---|---|---|
| 1 | Mapping signed off by the business (H-06) | `docs/migration/mapping.md` approval |
| 2 | At least **two full rehearsals** on a non-production Neon branch, timed (PLAN §15 step 5) | rehearsal notes: duration of freeze → import → reconcile |
| 3 | Reconciliation within the agreed tolerance (Q-08, default ±₹1 per customer), every exception explained | T-094 report, signed |
| 4 | **Restore drill passed on a real production backup** within the last 30 days (PRD §15 #14) | restore-log.md entry |
| 5 | Monitoring live: Sentry rules applied, uptime check green, `nightly-backup` monitor green 3 nights in a row (monitoring.md §2–3) | Sentry screenshots (no data) |
| 6 | Production configured (H-01) and domain decided (H-02); `/api/health` 200 | environments.md §4.11 |
| 7 | Lineman app on Play, installed on every lineman's phone (closed track or production) | H-08 pilot notes |
| 8 | Owners trained; they know who to call; support phone staffed for the first week | names |
| 9 | Rollback plan read by everyone involved (§5); the decision owner named | names |
| 10 | Date chosen per §2 | calendar |

## 2. Choosing the date

- **Mid-month (10th–20th), a weekday**, never within 3 days of the 1st: the new system's first bill run
  should be a normal 1st-of-month run after a quiet settling-in period, and the legacy month's bills
  are then already made and imported.
- Start the freeze **in the evening (IST)**, after the day's collections are handed over in the legacy
  system, so the final import has a complete day.
- Allow the rehearsal duration × 2 before the go-live point (§4 step 9).

## 3. The day before

1. Tell every operator, in plain words and their language: "Tomorrow evening at ____ the old app stops
   taking entries. From ____ use the new app. Your customers and dues move over."
2. Owners: make sure each lineman has a password in the new system (Settings → Team; migrated linemen
   need one because legacy passwords are not copied, FR-028) and is signed in on their phone.
3. Run the production backup by hand (Actions → Backup → `backup`) and check it is in the bucket.

## 4. Cutover steps (T = freeze time)

| Step | When | What | Done when |
|---|---|---|---|
| 1 | T | **Freeze legacy writes**: stop the legacy app; make the legacy database read-only (MariaDB: `SET GLOBAL read_only = ON; SET GLOBAL super_read_only = ON;` or the host's equivalent). Try one write: it must fail. | write refused |
| 2 | T + 10 min | **Final legacy dump**, with a checksum, kept per `docs/migration/README.md` (outside the repo). Make a second encrypted copy for the **12-month** read-only retention (Q-07) in a bucket **without** the 30-day rule. | two copies, checksums equal |
| 3 | T + 20 min | Note the Neon timestamp (the PITR rewind point if the import must be undone) and run the backup workflow again. | timestamp in the log |
| 4 | | **Import** into production: `____` (T-092 master data, T-093 invoices/payments/ledger; commands go here when those tasks land). Migrated operators are created by `provisionTenant` by `op_id`, never merged by name. | tool exit 0 |
| 5 | | **Reconcile**: T-094 report per operator (counts, invoice/payment/outstanding totals, exceptions, rounding). | within tolerance |
| 6 | | **Books check**: call `/api/cron/invariants` then `/api/cron/job-worker` (billing-run-failure.md §1 step 3 shows the commands). | 0 violations, an `ok` row per tenant |
| 7 | | **No double bills**: for each migrated operator, Bills → Runs → preview the current month: it must show 0 customers to bill (the month's legacy bills were imported). The scheduler also never auto-bills a tenant created during the month (T-044). | 0 to bill everywhere |
| 8 | | **Subscriptions** for migrated operators: admin console → extend (T-086), so nobody lands in grace or view-only on day 1. | each `active` |
| 9 | before T + ____ h | **Sign-off**: business owner and engineering sign the reconciliation and this checklist (H-09). This is the **go-live point**. | signatures |
| 10 | | **Go live**: Owners sign in; one Owner records a test of a real counter payment and its receipt; one lineman collects and syncs. | both seen in the app |
| 11 | | Tell everyone: "The new app is live." Keep the legacy system read-only (do not delete it). | message sent |

## 5. Rollback

| When | How | What is lost |
|---|---|---|
| **Before step 9 (go-live point)** | Abort: turn legacy writes back on (`read_only = OFF`), restart the legacy app, tell operators to carry on as before. Production: leave the imported tenants switched off (never delete; financial rows are append-only), or rewind production to step 3's timestamp (backup-and-restore.md §3) if nothing else lives there yet. | nothing: the legacy data never changed |
| **After go-live, same day** | Only if the new system cannot be used at all and a fix is not near. Decision: the business owner. Export everything recorded in the new system since go-live (Owners: Reports → Download data), turn legacy writes back on, re-enter those payments in the legacy system by hand, then fix and plan a new cutover. | the effort of re-entry; risk of mistakes |
| **Later** | Not a rollback any more: fix forward (rollback.md §1–3). | — |

## 6. Hypercare (until the first full bill cycle is done)

- Every morning: monitoring.md §6 checks, payments to check (`/payments/review`), handovers with
  discrepancies, support calls. Note anything odd in the hypercare log.
- The night of the **1st**: watch the bill run (00:15 IST). By morning every migrated operator's run
  is `completed`; compare totals with what the business expects from the legacy months; handle
  problems with billing-run-failure.md.
- Exit (PLAN Phase 6): the first full monthly cycle completes with no critical financial defects.
  Then hand over to support, and record the legacy read-only end date (Q-07: 12 months).
