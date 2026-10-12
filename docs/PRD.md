# Product Requirements Document (PRD) — Cable Operator Billing Platform v1.0

_Cable Operator Billing Platform — Product definition, user experience, functional requirements and acceptance criteria_

> Converted from the original RTF in this folder. This Markdown copy is the working source of truth; keep both in sync if the RTF is revised.

| Document         | Product Requirements Document                      |
|----------------------|----------------------------------------------------|
| **Version / status** | v1.0 — Working draft for stakeholder review        |
| **Product scope**    | Multi-tenant cable operator billing SaaS for India |
| **Platforms**        | Web dashboard and Android field-collection app     |

## Document control

| Field            | Value                                                                                                                                                                   |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Purpose              | Define what the product must do and how success will be evaluated.                                                                                                          |
| Primary audience     | Product owner, engineering, QA, UX, implementation and operations teams.                                                                                                    |
| Release target       | MVP followed by a controlled migration and production cutover.                                                                                                              |
| Requirement language | MUST = required for MVP; SHOULD = important unless explicitly deferred; COULD = later enhancement.                                                                          |
| Out of scope for MVP | Automated payment-gateway collection, direct SMS/WhatsApp provider integration, full GST e-invoicing compliance, set-top-box provisioning, and microservices decomposition. |

## 1. Product summary

Build a reliable, multi-tenant billing and field-collection platform for local cable TV operators in India. The platform replaces a legacy MariaDB/MySQL application with a modern web dashboard for operators and office staff, plus an Android app for linemen to collect payments, work offline, view customer balances, and issue receipts.

The financial model is customer-centric: a customer can have multiple VC (Viewing Card / cable connection) assignments, each with its own monthly rental plan, while invoices, payments, arrears and account credit are managed at customer level. The system must preserve history when a VC number is reused for a different customer.

## 2. Product goals and non-goals

| Type | Statement                                                                 | Measure / evidence                                                                                  |
|----------|-------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Goal     | Replace the current legacy billing workflow without losing available history. | Reconciled migration counts and financial totals; signed-off cutover.                                   |
| Goal     | Generate predictable monthly invoices.                                        | Billing run is idempotent; eligible customers are billed once per period.                               |
| Goal     | Make field collection resilient to poor connectivity.                         | Offline payments persist locally and sync without duplicate posting.                                    |
| Goal     | Improve financial traceability.                                               | Every payment, allocation, receipt and adjustment is auditable.                                         |
| Goal     | Support independent cable operators in one SaaS product.                      | No cross-tenant data exposure in tests or production.                                                   |
| Non-goal | Replace the cable operator's head-end, CAS, or set-top-box management system. | No equipment provisioning in MVP.                                                                       |
| Non-goal | Act as a payment processor or verify UPI transactions.                        | Cash/UPI are recorded as collection methods; UPI reference is informational unless separately verified. |
| Non-goal | Automatically send messages through a provider.                               | Android launches WhatsApp/SMS apps; the user completes the send.                                        |

## 3. Users, roles and permissions

| Role                    | Primary responsibilities                                                                                        | Access boundaries                                                                                   |
|-----------------------------|---------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| SaaS platform administrator | Create/disable operator tenants, manage subscription state, support operations and platform-level audit.            | Platform metadata and explicitly authorized support access; no routine access to tenant financial data. |
| Operator owner/admin        | Manage operator profile, staff, plans, customers, VCs, billing, payments, reports and subscription.                 | Only their own operator tenant.                                                                         |
| Office staff                | Maintain customers and connections, run/review billing, record and reconcile payments, view reports.                | Tenant-scoped; configurable permission set recommended.                                                 |
| Lineman                     | Search customers, record cash/UPI collections, operate offline, issue/print/share receipts, complete cash handover. | Tenant-scoped field workflows; no access to platform administration or unrelated operators.             |

All server-side authorization MUST derive tenant scope from the authenticated account and validated relationships, not from a client-supplied operator ID alone.

## 4. Core domain concepts

| Concept        | Definition / rule                                                                                                                          |
|--------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Operator / tenant  | A cable business using the platform. Every business record is tenant-scoped.                                                                   |
| Customer           | The payer/account holder. Customer code is unique within an operator, not globally.                                                            |
| VC asset / number  | A physical/logical cable connection identifier that can be reused after disconnection.                                                         |
| VC assignment      | A time-bounded association between a VC asset/number and a customer. Reassignment creates a new assignment identity and preserves the old one. |
| Rental plan        | Operator-defined monthly amount assigned to a VC assignment. Plan changes have effective dates and an explicit billing effect.                 |
| Invoice            | Customer-level monthly bill consolidating eligible rental across all active VCs, with prior outstanding balance shown separately.              |
| Payment            | Customer-level receipt of funds; supports partial payment and is not intrinsically tied to one VC.                                             |
| Payment allocation | The application of payment value to outstanding invoices, oldest due first by default.                                                         |
| Customer credit    | Unallocated excess payment carried as credit and applied according to the configured allocation policy.                                        |
| Receipt            | Immutable proof of a recorded payment; permanent server receipt number after sync and provisional local reference while offline.               |
| Collection session | Lineman's collection activity for a business day/shift, with cash and UPI totals and handover/reconciliation.                                  |

## 5. MVP scope

- Multi-tenant operator onboarding and tenant isolation.

- Authentication, role-based access, operator/staff/lineman management.

- Customer and contact management, customer-code uniqueness per operator, audit history for mobile-number changes.

- VC inventory, assignment history, activation, suspension, disconnection and reactivation.

- Operator-defined monthly rental plans and per-VC plan assignment.

- Calendar-month billing; automatic monthly bill generation on the first day; manual preview/retry for authorized staff.

- Customer-level invoice ledger, arrears carry-forward, partial payments, oldest-first allocation and excess credit.

- Cash and UPI payment recording, including offline Android collection and idempotent synchronization.

- Receipts: print-on-request to compatible Bluetooth thermal printer, WhatsApp PDF + preview link, SMS preview link.

- Lineman collection summary, cash handover, UPI/cash separation and discrepancy reporting.

- Migration of available customers, VCs, invoices, ledger/payment history and relevant reference data from the legacy database.

- Basic reports, audit trail, operational monitoring, backups and restore validation.

- Flat monthly SaaS subscription with unlimited customers; subscription lifecycle and access-state handling.

## 6. Out of scope / later phases

- Automated recurring payment collection, payment gateway integration, bank reconciliation and UPI verification.

- Provider APIs for WhatsApp/SMS delivery, delivery receipts, templates or campaign messaging.

- Complex tax workflows, GST e-invoicing/e-way bills, tax filing or accountant-grade statutory reports; data model must remain extensible.

- Inventory management for routers/set-top boxes, technician work orders, complaint/ticketing and network monitoring.

- Customer self-service portal, online payment portal and customer-facing mobile app.

- Advanced analytics, forecasting, commission payroll, route optimization and multi-level franchise settlements.

- Native iOS app and web-based offline collection.

## 7. Functional requirements

| ID | Requirement           | Priority | Description                                                                                                                                                                                                | Acceptance criteria                                                                                         |
|--------|---------------------------|--------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| FR-001 | Tenant isolation          | MUST         | Every operator-owned entity is tenant-scoped. API reads, writes, exports, background jobs and object-storage links must enforce tenant scope.                                                                  | Automated cross-tenant negative tests pass; no cross-tenant record is returned or mutated.                      |
| FR-002 | Operator identity         | MUST         | Operators with identical display names remain separate tenants. Tenant identity is an immutable internal ID.                                                                                                   | Two tenants named “ANMOL CABLE NETWORK” can hold independent users, customers and finances.                     |
| FR-003 | Customer management       | MUST         | Create, edit, search, view and deactivate customer records; capture customer code, name, phone, address, area and available KYC metadata.                                                                      | Customer code uniqueness is enforced on (operator_id, normalized_customer_code).                                |
| FR-004 | Mobile-number handling    | MUST         | Before message preparation, show the stored number for confirmation. If missing, require entry. Number changes create an audit event.                                                                          | History records old/new value, actor, timestamp and source.                                                     |
| FR-005 | VC inventory and history  | MUST         | Create and manage VC number/asset; maintain assignment periods and never overwrite old customer history on reuse.                                                                                              | A reused VC number has separate assignment records and no old charge is attributed to the new customer.         |
| FR-006 | VC status                 | MUST         | Support active, temporarily suspended, permanently disconnected and reactivated states, with effective dates and reason/audit metadata.                                                                        | State transitions are validated; future rental follows the agreed effective-period rules.                       |
| FR-007 | Rental plans              | MUST         | Operator can create/edit/retire monthly rental plans and assign a plan or amount to each VC assignment.                                                                                                        | Historical invoices retain the applied amount even if a plan is later edited.                                   |
| FR-008 | Plan changes              | MUST         | An immediate plan change applies the new full monthly rental in the current month as decided for MVP. If an invoice already exists, prevent duplicate charging and create an auditable adjustment/rebill path. | One customer is not charged twice for the same VC/month; prior issued invoices are not silently rewritten.      |
| FR-009 | Monthly billing           | MUST         | Generate calendar-month invoices on the first. Consolidate current eligible rental across customer VCs and show prior balance separately.                                                                      | Each customer/period has at most one canonical invoice; repeated job execution is idempotent.                   |
| FR-010 | Billing eligibility       | MUST         | VC activation, suspension and disconnection are evaluated using effective dates and an explicit monthly cut-off policy.                                                                                        | A VC disconnected in a month stops rental from the following month; historical charges remain.                  |
| FR-011 | Invoice ledger            | MUST         | Track invoice amount, opening balance, charges, payments/allocations, due amount, issue status and period.                                                                                                     | Invoice and customer account balances reconcile to posted transactions.                                         |
| FR-012 | Arrears                   | MUST         | Outstanding balances carry forward at customer level. Previous dues remain due even if a VC is suspended/disconnected.                                                                                         | Closing balance for a period becomes the next period's opening balance.                                         |
| FR-013 | Payments                  | MUST         | Record cash or UPI payments against a customer, amount, time, collector, reference/notes and source device.                                                                                                    | Posted payment is immutable; corrections use reversal/adjustment entries.                                       |
| FR-014 | Allocation                | MUST         | Allocate payment to oldest outstanding invoice first; allow partial settlement. Excess becomes customer credit.                                                                                                | Allocation total never exceeds payment amount; unapplied remainder equals credit.                               |
| FR-015 | Offline collection        | MUST         | Android app stores payment drafts durably offline, uses a UUID idempotency key, queues sync and exposes sync state.                                                                                            | Repeated sync or retry never duplicates a payment or receipt.                                                   |
| FR-016 | Offline receipt reference | MUST         | Show a clearly provisional local reference while offline; replace/link it to permanent server receipt number after sync.                                                                                       | The provisional reference is traceable to the permanent receipt.                                                |
| FR-017 | Receipt creation          | MUST         | Payment persistence is independent from printing or sharing. Receipt includes operator/customer, amount, method, date/time, collector, reference, allocation/balance summary and receipt identifier.           | Failure to print/share does not undo or duplicate the payment.                                                  |
| FR-018 | Thermal printing          | MUST         | Print only on user request to a paired/available compatible Bluetooth thermal printer; support retry and readable receipt layout.                                                                              | Printer errors are surfaced; payment remains recorded.                                                          |
| FR-019 | WhatsApp share            | MUST         | Prepare a PDF receipt and online preview link, then launch the installed WhatsApp app/share sheet. Do not claim the message was delivered.                                                                     | UI records preparation/launch outcomes only, not provider delivery.                                             |
| FR-020 | SMS share                 | MUST         | Open SMS composer with confirmed phone number and secure preview link. User presses Send in the SMS app.                                                                                                       | UI does not report SMS delivery without a provider receipt.                                                     |
| FR-021 | Secure receipt preview    | MUST         | Use an unguessable tokenized link with expiration/revocation controls and rate limiting; minimize exposed personal data.                                                                                       | Expired/revoked links stop working; access events are logged where appropriate.                                 |
| FR-022 | Collection session        | MUST         | Provide daily collection totals by lineman and method, payment list, cash handover amount, UPI total and discrepancy reason.                                                                                   | Cash expected vs handed over is computed and exceptions are visible.                                            |
| FR-023 | Reports                   | MUST         | Provide customer dues, invoice register, payment register, daily collections, outstanding ageing and operator-level summaries.                                                                                 | Report totals reconcile to the ledger for the same filters and as-of time.                                      |
| FR-024 | Audit trail               | MUST         | Record actor, tenant, action, entity, timestamp, and meaningful before/after values for sensitive changes and financial adjustments.                                                                           | Audit records are searchable by authorized operator admins and platform support policy.                         |
| FR-025 | Subscription              | MUST         | Support flat monthly SaaS subscription with unlimited customers; track plan, billing dates, active/grace/suspended status and operator access policy.                                                          | Subscription expiry/renewal does not delete tenant data.                                                        |
| FR-026 | Legacy migration          | MUST         | Import available history with source IDs and reconciliation reports; preserve source as read-only during cutover.                                                                                              | Counts, financial totals and exception lists are signed off before production switch.                           |
| FR-027 | Import exception handling | MUST         | Do not fabricate missing assignments or transaction history. Flag orphaned, malformed, ambiguous or unmappable records.                                                                                        | Every skipped/transformed row appears in a migration exception report.                                          |
| FR-028 | Account access            | MUST         | Use secure password hashing, session/token expiry, rate limiting and account recovery. Legacy password migration requires algorithm verification.                                                              | No plaintext legacy password is carried forward; unsupported legacy credentials trigger reset/secure migration. |
| FR-029 | Data export               | SHOULD       | Allow authorized operator export of customer, invoice and payment data in common formats, scoped to tenant.                                                                                                    | Export permissions and export event are logged.                                                                 |
| FR-030 | Bulk operations           | SHOULD       | Support safe customer/VC import and bulk updates with preview, validation and error report.                                                                                                                    | Bulk operation cannot bypass validation or tenant scope.                                                        |

## 8. Business rules and edge cases

| Rule ID | Rule                                                                                                                                                                                              |
|-------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| BR-01       | Customer code uniqueness is per operator. The same code may exist in different operators.                                                                                                             |
| BR-02       | Tenant IDs, customer IDs, VC assignment IDs, invoice IDs and payment IDs are separate internal identities; display numbers are not primary keys.                                                      |
| BR-03       | A VC number may be reused after permanent disconnection, but active assignment periods for the same operator/VC number must not overlap.                                                              |
| BR-04       | A new VC assignment starts a new financial attribution period. Old invoices, payments and adjustments remain attached to the original customer/account history.                                       |
| BR-05       | Each VC assignment has its own monthly rental amount/plan. Invoice and customer account are consolidated at customer level.                                                                           |
| BR-06       | Calendar-month billing runs on the first. The job must be safe to retry and must not create duplicate invoices.                                                                                       |
| BR-07       | MVP policy for an immediate plan change is the full new rental for the current month. Changes after invoice issue require an auditable adjustment/rebill process rather than silent invoice mutation. |
| BR-08       | VC disconnection stops future rental from the following month. A suspension stops future rental according to its effective-period rule; already-issued invoices are not automatically rewritten.      |
| BR-09       | Payment allocation defaults to oldest outstanding invoice first. Partial payments are allowed; excess funds become customer credit.                                                                   |
| BR-10       | UPI reference text entered by a lineman is not proof of successful transfer. Record method and reference separately from verification state.                                                          |
| BR-11       | Offline-created payment is not considered server-posted until sync succeeds, but it must remain visible locally with a clear pending state.                                                           |
| BR-12       | Printing or launching a share sheet is not equivalent to customer receipt/delivery. Never report delivery without provider evidence.                                                                  |
| BR-13       | A payment correction is represented by a reversal/adjustment linked to the original payment; do not delete posted financial transactions.                                                             |
| BR-14       | Missing or invalid legacy data is flagged for review. Do not infer facts not present in source records.                                                                                               |

## 9. Key user journeys

### J-01: Onboard operator

1.  Platform admin creates tenant and initial owner account.

2.  Owner completes operator profile and subscription state is initialized.

3.  Owner creates staff/lineman accounts and configures rental plans.

### J-02: Add customer and VC

1.  Office staff creates customer with tenant-unique customer code.

2.  Staff adds one or more VC assignments and assigns rental plan/amount.

3.  System validates that the VC number is not currently assigned to another active customer within the operator.

### J-03: Monthly billing

1.  Scheduled billing run selects eligible VC assignments for the target calendar month.

2.  System calculates customer-level rental, adds opening arrears and any approved adjustments, and creates one canonical invoice per customer/period.

3.  Run summary shows created, skipped, failed and exception counts; authorized staff can inspect and retry safely.

### J-04: Lineman collects payment

1. Lineman searches customer by code, name, phone or VC number.

2. App displays customer identity, outstanding invoices and balance.

3. Lineman records amount and cash/UPI method; enters optional UPI reference/notes.

4. Online: server confirms posting and returns permanent receipt number. Offline: app stores locally and displays provisional reference and pending-sync status.

5. Lineman optionally prints, shares via WhatsApp PDF + link, or opens SMS composer.

### J-05: Reconcile collection

1. Lineman reviews daily collection totals split into cash and UPI.

2. Lineman enters cash amount handed over and notes discrepancies.

3. Office staff reviews expected vs actual cash, UPI totals and unresolved offline syncs.

4. Reconciliation is finalized with actor, timestamp and audit trail.

### J-06: Reuse disconnected VC

1. Staff permanently disconnects old assignment with effective date.

2. The system closes the assignment and stops future rental from the following month.

3. When reissued, a new assignment is created for the new customer; previous invoices and ledger history stay with the original customer.

### J-07: Send a receipt

1. User selects a receipt action after payment has been saved.

2. App confirms or collects the mobile number and records any number change.

3. WhatsApp flow prepares PDF plus preview link; SMS flow prepares link only.

4. App records that the share/composer was launched. Delivery status remains unknown unless a future provider integration supplies it.

## 10. Screens and navigation inventory

| Surface | Screen / module     | Key capabilities                                                                                   |
|-------------|-------------------------|--------------------------------------------------------------------------------------------------------|
| Web         | Overview dashboard      | Collections today, outstanding balance, billing-run status, overdue accounts, reconciliation alerts.   |
| Web         | Customers               | Search/filter, profile, contact details, VC list, ledger, invoice/payment history.                     |
| Web         | VCs and plans           | Assignment timeline, status transitions, plan/rental changes, disconnect/reactivate.                   |
| Web         | Billing and invoices    | Billing calendar, run preview, run status, invoice register, invoice detail, adjustment/reversal flow. |
| Web         | Payments and ledger     | Payment register, allocations, customer credit, reversals, audit history.                              |
| Web         | Collections             | Lineman daily totals, cash handover, discrepancy resolution, sync exceptions.                          |
| Web         | Reports                 | Outstanding dues, ageing, payment register, daily collection, invoice register, exports.               |
| Web         | Administration          | Operator profile, users/roles, plans, subscription status, audit log.                                  |
| Android     | Sign-in and sync status | Secure sign-in, current operator, last sync, queued changes, retry controls.                           |
| Android     | Customer search/profile | Search by code/name/phone/VC; display identity and balance with last-updated indicator.                |
| Android     | Record collection       | Amount, cash/UPI, UPI reference, notes, confirm and save.                                              |
| Android     | Receipt actions         | View receipt, print, WhatsApp share, SMS link; separate payment success from delivery action.          |
| Android     | Daily collections       | Method totals, transaction list, cash handover and discrepancy reason.                                 |
| Android     | Offline queue           | Pending/failed/synced records, retry and conflict explanation.                                         |

## 11. Non-functional requirements

| Area                | Requirement                                                                                                                                                                               |
|-------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Security                | TLS in transit; managed encryption at rest; secure password hashing; short-lived access tokens; refresh/session revocation; rate limits; audit logs; least privilege.                         |
| Tenant isolation        | Tenant scope is enforced in API/service/data-access layers and background jobs; tests cover guessed IDs and cross-tenant references.                                                          |
| Reliability             | Billing and payment posting are transactional and idempotent; background jobs retry safely; failed jobs are observable and recoverable.                                                       |
| Offline durability      | Payments persist in Android Room/local durable storage before the app acknowledges local save; sync queue survives process death and device restart.                                          |
| Performance             | Target common list/search operations at p95 under 2 seconds for expected initial scale; dashboard summaries should be paginated/cached where appropriate. Validate with realistic load tests. |
| Scale                   | Initial known legacy snapshot is approximately 8 operators, 7,616 customers, 7,334 VC records and 146,224 invoices. Design should accommodate growth without architectural rewrite.           |
| Accessibility/usability | Readable mobile UI in field conditions, large tap targets, explicit offline/last-sync state, low-bandwidth-friendly payloads.                                                                 |
| Observability           | Structured logs, metrics for billing runs/payment sync/errors, alerting for failed billing, elevated sync failure and database/backup health.                                                 |
| Backup/recovery         | Automated backups, documented recovery objectives, and periodic restore tests before cutover.                                                                                                 |
| Privacy                 | Collect only required customer data; restrict receipt preview fields; define retention and deletion policy with business/legal review.                                                        |
| Compatibility           | Android app supports a declared minimum OS/device range; thermal printing is tested against a declared printer compatibility list.                                                            |
| Localization            | MVP language decision is pending. Keep labels, dates, currency and messages localization-ready; default currency is INR.                                                                      |

## 12. Data and entity model (logical)

| Entity                   | Important fields / relationships                                                                   | Notes                                                                             |
|------------------------------|--------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| Operator                     | id, name, status, profile, subscription_id                                                             | Tenant root; duplicate names permitted.                                               |
| User                         | id, operator_id, role, login, password_hash, status                                                    | Lineman may be a user role or a linked field-worker profile.                          |
| Customer                     | id, operator_id, customer_code, name, phone, address, area, status                                     | Unique key: operator_id + normalized customer_code.                                   |
| VC asset/number              | id, operator_id, vc_number, lifecycle_status                                                           | Reusable identifier; avoid using number as immutable PK.                              |
| VC assignment                | id, vc_asset_id, customer_id, start_date, end_date, status, rental_plan_id, rental_amount              | New row per assignment period; prevent overlapping active assignments.                |
| Rental plan                  | id, operator_id, name, monthly_amount, active/effective dates                                          | Amounts stored as integer paise or fixed decimal; never float for money.              |
| Invoice                      | id, operator_id, customer_id, period, invoice_number, issued_at, status, totals                        | Unique canonical invoice per customer/period; immutable issued snapshot.              |
| Invoice line                 | id, invoice_id, assignment_id, description, period, amount                                             | Retains attribution to the VC assignment that generated rental.                       |
| Payment                      | id, operator_id, customer_id, amount, method, collected_at, collector_id, idempotency_key, sync_status | Posted transactions are immutable; unique idempotency key within tenant/source scope. |
| Payment allocation           | id, payment_id, invoice_id, amount                                                                     | Supports partial payment and oldest-first allocation.                                 |
| Customer credit / adjustment | id, customer_id, type, amount, source_payment_id, reason                                               | Auditable ledger entries; excess payment becomes credit.                              |
| Receipt                      | id, payment_id, permanent_number, provisional_reference, preview_token_hash, expiry/revoked_at         | Permanent number allocated by server; token stored hashed where feasible.             |
| Collection session           | id, operator_id, collector_id, business_date, cash_expected, cash_handed_over, upi_total, discrepancy  | Reconciliation and sign-off history.                                                  |
| Audit event                  | id, operator_id, actor_id, entity_type, entity_id, action, before/after, timestamp                     | Sensitive values should be redacted or minimized.                                     |
| Migration batch/exception    | id, source_table, source_key, outcome, error, checksum                                                 | Supports repeatable imports and auditability.                                         |

Money must use integer paise or a fixed-precision decimal type, never floating-point types. Timestamps should be stored consistently (UTC) and displayed in India Standard Time for operator-facing business dates unless the deployment decision explicitly differs.

## 13. Billing and payment calculations

### 13.1 Invoice calculation

For each customer and billing period, calculate the eligible rental lines from VC assignments under the approved effective-date policy. The invoice should show current-period rental, approved adjustments/credits, prior outstanding amount and total due. The exact treatment of plan changes made after invoice issue must be an explicit adjustment/rebill workflow.

### 13.2 Payment allocation

1. Validate amount is positive and method is cash or UPI.

2. Persist the payment idempotently and atomically with its ledger event.

3. Order eligible outstanding invoices oldest due date first, then stable invoice ID as tie-breaker.

4. Allocate as much as possible to each invoice; allow partial settlement.

5. Place any remainder in customer credit and show it separately from invoice payment allocations.

6. Generate permanent receipt number only when the server accepts the payment; preserve provisional offline reference as an alias.

### 13.3 Offline sync and conflicts

- Local payment must have a UUID idempotency key created before local save.

- Sync sends original event identity, collector identity, device identity, recorded time, amount, method, customer ID and optional reference/notes.

- Server validates tenant membership and customer identity, checks idempotency key, then posts once.

- If the customer/assignment state changed while offline, preserve the payment event and flag review if necessary; do not silently discard a genuine collection.

- A server rejection must explain whether the payment is already posted, needs reassignment/review, or is invalid; retry must be safe.

- Show local recorded time and server-posted time distinctly where they differ.

## 14. Migration and cutover requirements

- Source is a MariaDB/MySQL database with tables including operator, costumer, vc, invoice, ledger, lineman and additional recharge/plan reference tables.

- Retain source primary keys as legacy reference fields; create new internal IDs where the target model requires new identities.

- Preserve operator identity by op_id, not by operator display name. Two records named “ANMOL CABLE NETWORK” are distinct tenants.

- Migrate all available customer, VC, invoice, ledger and payment history; inspect recharge and plan definitions before final field mapping.

- Do not infer missing VC assignment history from current-state rows. Where history is absent, import the known current assignment and mark historical attribution limitations.

- Normalize legacy date sentinels such as zero dates into explicit unknown/null plus migration exception where appropriate.

- Review monetary types: legacy invoice amounts are integer fields while ledger amounts are FLOAT; reconcile rounding and unit assumptions before migration.

- Preserve old invoice number and receipt semantics as legacy references even if the new system assigns new canonical identifiers.

- Run dry migration, compare per-operator counts and financial totals, review exceptions, freeze source writes, final sync, then switch production.

- Keep source read-only and backed up for an agreed retention window after cutover.

| Validation        | Expected evidence                                                                                 |
|-----------------------|-------------------------------------------------------------------------------------------------------|
| Record counts         | Source vs target counts by entity and operator, with explained exclusions.                            |
| Financial totals      | Invoice totals, paid totals, outstanding balance and payment totals by operator and period.           |
| Referential integrity | Orphan customer/VC/invoice/lineman/recharge/plan references listed and resolved or accepted.          |
| Duplicate detection   | Duplicate customer codes within operator, duplicate invoice numbers, duplicate active VC assignments. |
| Ledger reconciliation | Opening balance and account balance comparisons; float rounding differences explained.                |
| Security              | Legacy passwords are not copied as plaintext; hash algorithm confirmed or reset flow used.            |
| Cutover approval      | Business owner signs reconciliation report and known limitations before live switch.                  |

## 15. Acceptance criteria for MVP release

1. A tenant administrator cannot access another operator's customer, VC, invoice, payment, report or receipt preview.

2. Customer code uniqueness is enforced per tenant while duplicate codes across tenants remain allowed.

3. A customer can have multiple active VCs, each with independent monthly rental, and receives one consolidated monthly invoice.

4. Billing can be run twice for the same period without duplicate invoices or duplicate rental charges.

5. A plan change after an invoice is issued cannot silently alter that issued invoice or double-charge the customer.

6. A disconnected VC can be reassigned to a new customer without moving historical charges or payments.

7. Partial payments allocate oldest-first and excess funds become visible customer credit.

8. An offline payment survives app restart, syncs later, and is not duplicated when the sync request is retried.

9. A permanent server receipt number is linked to the provisional local reference after sync.

10. Printing/share failures do not undo a saved payment.

11. WhatsApp and SMS workflows do not falsely claim message delivery.

12. Daily collection totals distinguish cash and UPI and support cash handover with discrepancy reason.

13. Migration counts and financial totals reconcile within approved tolerances; all exceptions are documented.

14. Backup restore and production monitoring checks pass before cutover.

## 16. Product analytics and operational metrics

| Metric                      | Definition / use                                                                        |
|---------------------------------|---------------------------------------------------------------------------------------------|
| Billing success rate            | Successful canonical invoices divided by eligible customer-period invoices.                 |
| Billing exception rate          | Failed/skipped invoices requiring human review, segmented by reason.                        |
| Payment sync success rate       | Offline payments accepted by server divided by sync attempts, deduplicated by payment UUID. |
| Duplicate prevention count      | Idempotent retries detected; used to validate safe retry behavior.                          |
| Receipt action usage            | Print, WhatsApp share launch and SMS composer launch counts; not message delivery.          |
| Reconciliation discrepancy rate | Collection sessions with cash discrepancy divided by closed sessions.                       |
| Migration exception count       | Rows needing manual mapping or business review.                                             |
| Active operator / field usage   | Weekly active operators and linemen, subject to privacy and retention policy.               |

## 17. Dependencies, risks and mitigations

| Risk / dependency                          | Impact                               | Mitigation                                                                                        |
|------------------------------------------------|------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Legacy schema semantics unclear                | Incorrect balances or migration mapping. | Inspect recharge/plan tables, profile sample records, build mapping document, dry-run reconciliation. |
| Float values in legacy ledger                  | Rounding or balance mismatches.          | Agree money units/rounding policy; use fixed precision in target; reconcile exceptions.               |
| Legacy password format unknown                 | Login migration risk.                    | Verify hash algorithm; otherwise require password reset or one-time secure credential migration.      |
| Poor field connectivity                        | Delayed posting and stale balances.      | Durable local queue, explicit sync state, idempotency and conflict workflow.                          |
| Android intent does not prove message delivery | False delivery claims.                   | Track prepared/launched/user-confirmed states only; provider integration is later scope.              |
| Printer compatibility varies                   | Receipt printing failures.               | Declare tested printer models/protocols and keep printing optional.                                   |
| Tenant-scoping defect                          | Severe data breach.                      | Centralized tenant authorization, DB constraints, negative tests and audit/monitoring.                |
| Billing edge cases after issue                 | Overbilling or duplicate rental.         | Immutable issued invoices and explicit adjustment/rebill workflow.                                    |

## 18. Open decisions to close before build

| Decision                             | Proposed baseline                                                                                    | Owner / when                                      |
|------------------------------------------|----------------------------------------------------------------------------------------------------------|-------------------------------------------------------|
| Minimum Android OS and supported devices | Set after field-device survey and printer tests.                                                         | Product + engineering, before Android implementation. |
| Suspension effective-date rule           | Stops rental from the next eligible billing period; never silently rewrite issued invoice.               | Product/business, before billing implementation.      |
| Plan change after billing issue          | Credit/debit adjustment or controlled rebill with audit trail.                                           | Product/business, before billing implementation.      |
| Invoice numbering policy                 | Tenant-specific sequence, immutable and unique within tenant.                                            | Product + finance, before invoice module.             |
| Credit application policy                | Automatically apply customer credit to oldest outstanding invoice by default, with clear ledger entries. | Business owner, before payment module.                |
| Subscription grace/suspension policy     | Define grace days, read-only mode and reactivation behavior.                                             | SaaS owner, before launch.                            |
| Language and currency display            | INR; localization-ready; choose initial UI language(s).                                                  | Product, before UX sign-off.                          |
| Data retention and receipt-link expiry   | Define retention period and default link expiry/revocation policy.                                       | Product/security/legal, before launch.                |
| Tax fields and compliance roadmap        | Basic receipts now; extensible tax fields; obtain professional advice before statutory invoice features. | Business owner, before public launch.                 |
| Operational ownership and support SLA    | Define incident response, billing-job monitoring and tenant support process.                             | Operations, before cutover.                           |

## 19. Recommended delivery sequence

| Phase                       | Focus                                                                                                       | Exit gate                                                      |
|---------------------------------|-----------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| 0\. Discovery and specification | Confirm legacy semantics, recharge/plan mapping, business rules, language, subscription and device constraints. | Signed PRD/BRD, field mappings, unresolved decisions assigned.     |
| 1\. Foundation                  | Tenant model, authentication, roles, customer/VC master data, audit, environments and CI/CD.                    | Tenant isolation tests and CRUD workflows pass.                    |
| 2\. Financial core              | Rental plans, billing, invoices, allocations, credits, payments, adjustments and reports.                       | Billing/payment acceptance criteria and reconciliation tests pass. |
| 3\. Android field app           | Customer lookup, online/offline payment capture, sync queue, receipt actions and daily collections.             | Offline/retry/device restart tests pass.                           |
| 4\. Migration and UAT           | Dry migration, data reconciliation, field testing, printer compatibility and training.                          | Business sign-off and cutover rehearsal pass.                      |
| 5\. Cutover and stabilization   | Read-only legacy freeze, final import, production verification and monitoring.                                  | No critical financial/data defects; rollback plan validated.       |

## Appendix A. Known legacy baseline

| Entity                            | Observed count |
|---------------------------------------|--------------------|
| Operators                             | 8                  |
| Customers (legacy table \`costumer\`) | 7,616              |
| VC records                            | 7,334              |
| Invoice records                       | 146,224            |
| Ledger rows                           | 7,334              |
| Lineman records                       | 134                |

These are baseline counts from the supplied database snapshot, not a final migration reconciliation. Per-operator invoice group totals previously summed to one more than the global invoice count, so that discrepancy remains a migration validation item. The legacy schema also contains \`recharge\` and \`plan\` tables whose full definitions must be mapped before finalizing migration.

## Appendix B. Legacy naming note

The source table is named \`costumer\` (not \`customer\`). Preserve the source name in migration scripts where needed, but use consistent target-domain naming such as \`customers\`. Legacy \`vc\` is current-state oriented; it does not by itself guarantee full historical assignment periods.
