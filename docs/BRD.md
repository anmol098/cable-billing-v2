# Business Requirements Document (BRD) — Cable Operator Billing Platform v1.0

_Cable Operator Billing Platform — Business case, operating model, business rules and measurable outcomes_

> Converted from the original RTF in this folder. This Markdown copy is the working source of truth; keep both in sync if the RTF is revised.

| Document         | Business Requirements Document                     |
|----------------------|----------------------------------------------------|
| **Version / status** | v1.0 — Working draft for stakeholder review        |
| **Product scope**    | Multi-tenant cable operator billing SaaS for India |
| **Platforms**        | Web dashboard and Android field-collection app     |

## Document control

| Field           | Value                                                                                                                  |
|---------------------|----------------------------------------------------------------------------------------------------------------------------|
| Purpose             | Describe the business problem, stakeholders, outcomes, scope, policies and business acceptance.                            |
| Primary audience    | Business owner, cable operator representatives, product leadership, finance/operations and implementation team.            |
| Business geography  | India; amounts and receipts are INR-oriented.                                                                              |
| Version / status    | v1.0 — Working draft for stakeholder review.                                                                               |
| Relationship to PRD | This BRD states business needs and rules. The companion PRD translates them into product behavior and acceptance criteria. |

## 1. Executive summary

The business needs a modern, dependable billing and collection system for local cable operators. The existing legacy application holds customer, VC, invoice, ledger and lineman information, but the target product must improve control, reliability, historical traceability and field collection resilience while supporting multiple independent operators in one SaaS platform.

The proposed solution consists of a web-based office/management dashboard and an Android app used by linemen. It will automate calendar-month billing, maintain customer-level balances across multiple VCs, support cash and UPI collections, continue collecting during connectivity interruptions, provide receipts through thermal printers and the installed WhatsApp/SMS apps, and preserve available legacy history during a controlled migration.

## 2. Business background and current-state context

- The current system uses a MariaDB/MySQL legacy database with operator, customer, VC, invoice, ledger and lineman tables, plus related reference tables.

- The supplied snapshot contains 8 operators, 7,616 customers, 7,334 VC records, 146,224 invoices, 7,334 ledger rows and 134 lineman records.

- Operator names are not reliable unique identifiers: two different operator records have the same display name and must remain separate businesses.

- The current-state VC table is not sufficient by itself to guarantee complete historical assignment history; the migration must preserve what exists and clearly mark limitations.

- Field collections occur in environments where connectivity may be unreliable; the Android app must preserve locally captured payment events and sync them safely later.

- The legacy invoice schema includes a nullable customer reference and ledger uses floating-point values, so migration must validate orphans and money precision rather than assume the source is clean.

## 3. Business problem statement

The business requires one dependable source of truth for customer accounts, VC rental, monthly invoices, arrears, payments and collection reconciliation. The target solution must reduce manual effort and ambiguity, protect financial history, support field staff in low-connectivity areas, and provide a scalable SaaS operating model without requiring each operator to run separate infrastructure.

## 4. Business objectives and success measures

| Objective           | Desired business outcome                                                 | Measure / acceptance evidence                                                            |
|-------------------------|------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Accurate billing        | Every eligible customer is billed correctly for the calendar month.          | Billing exceptions reviewed; no duplicate customer-period invoices; reconciliation sign-off. |
| Reliable collections    | Field payments are recorded even when the device is offline.                 | Offline payments survive restart and sync once; no duplicate posting in retry tests.         |
| Clear customer balances | Arrears, current rental, payments and credit are explainable.                | Customer account ledger reconciles to invoices and payments.                                 |
| Accountability          | Collections can be traced to the collector and method.                       | Daily cash/UPI totals and cash handover are reportable by lineman.                           |
| History preservation    | Available historical records remain accessible after migration.              | Counts and financial totals are reconciled and exceptions documented.                        |
| Multi-tenant SaaS       | Multiple independent operators share the service without sharing data.       | Tenant-isolation acceptance suite passes.                                                    |
| Operational simplicity  | Operators can use familiar phone apps and compatible Bluetooth printers.     | Field UAT validates print, WhatsApp and SMS handoff on target devices.                       |
| Commercial viability    | SaaS is monetized using a flat monthly subscription and unlimited customers. | Subscription states, renewal tracking and access policy operate as approved.                 |

## 5. Stakeholders and business responsibilities

| Stakeholder      | Interest / responsibility                                                      | Key decisions                                                                         |
|----------------------|------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| SaaS product owner   | Owns product outcomes, roadmap and release readiness.                              | MVP scope, subscription policy, product priorities.                                       |
| Cable operator owner | Accountable for customer records, pricing, collections and local business process. | Rental rules, staff permissions, billing exceptions and reconciliation.                   |
| Office staff         | Maintains accounts and handles billing/payment questions.                          | Customer corrections, approved adjustments and day-to-day operations.                     |
| Lineman / collector  | Collects cash or UPI payments and issues receipts in the field.                    | Accurate customer selection, payment method/reference, receipt actions and cash handover. |
| Finance / accountant | Validates balances, outstanding dues and audit trail.                              | Reconciliation tolerances, credit handling and financial reports.                         |
| Engineering / QA     | Implements and verifies product requirements.                                      | Technical design, test strategy, deployment and observability.                            |
| Migration lead       | Maps and reconciles source records into the new model.                             | Mapping exceptions, migration runbook and cutover evidence.                               |
| Support / operations | Supports operators and monitors service health.                                    | Incident process, access approvals and subscription support.                              |

## 6. Scope boundaries

### 6.1 In scope

- Web-based operator dashboard and Android lineman application.

- Multi-tenant operator, customer, VC, plan, invoice, payment, receipt and collection-session management.

- Automatic calendar-month billing on the first day.

- Customer-level balance and payment history with multiple VCs and consolidated invoices.

- Cash and UPI collection recording, offline capture and safe synchronization.

- Thermal printing on request and WhatsApp/SMS handoff using apps installed on the lineman's device.

- Daily collections, cash handover, reconciliation and basic management reporting.

- Flat monthly SaaS subscription with unlimited customers.

- One-time migration of all available relevant history from the legacy system.

### 6.2 Out of scope for initial release

- Direct integration with WhatsApp Business API or an SMS gateway.

- Automated online payment collection, gateway webhooks or UPI transaction verification.

- Statutory GST e-invoicing or tax filing; the initial receipt is a simple billing/collection receipt with an extensible data model.

- Customer self-service portal, equipment/stock management, technician service tickets and network monitoring.

- Full accounting/ERP, payroll and advanced franchise settlement.

## 7. Current and future operating model

| Process               | Current-state risk / constraint                                    | Future-state business process                                                                            |
|---------------------------|------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Customer setup            | Customer identity and code conventions may be embedded in legacy data. | Tenant-specific customer code; searchable customer profile; auditable contact changes.                       |
| VC management             | Current-state row may overwrite or omit assignment history.            | Separate VC identity and assignment periods; retain customer and financial history on reuse.                 |
| Monthly billing           | Billing behavior and retries may be difficult to audit.                | Scheduled first-of-month billing with preview, run summary, idempotent retry and exception queue.            |
| Payment collection        | Field connectivity and receipt creation can be inconsistent.           | Durable offline collection queue, idempotent server posting and permanent receipt after sync.                |
| Balance management        | Ledger/float fields can be difficult to reconcile.                     | Customer-level transaction ledger, invoice allocations and explicit credit/adjustment entries.               |
| Collection reconciliation | Cash/UPI and handover may require manual comparison.                   | Daily lineman summary, separate cash and UPI totals, cash handover and discrepancy reason.                   |
| Customer communication    | Message send and delivery can be conflated.                            | Prepare PDF/link and launch installed apps; only record states actually observable.                          |
| Legacy migration          | Orphans, duplicate names and historical gaps may exist.                | Controlled import with source IDs, exception register, reconciled totals and read-only source after cutover. |

## 8. Business requirements

| ID | Business requirement                                                                              | Priority | Business acceptance                                                                      |
|--------|-------------------------------------------------------------------------------------------------------|--------------|----------------------------------------------------------------------------------------------|
| B-001  | The system shall support multiple independent cable operators in one SaaS environment.                | Critical     | Tenant data and access are isolated; duplicate operator display names are permitted.         |
| B-002  | Each operator shall manage its own customers, users, linemen, VC inventory, rental plans and billing. | Critical     | An operator cannot see or change another operator's business data.                           |
| B-003  | A customer may have multiple VCs, each with its own monthly rental plan.                              | Critical     | All eligible VC rentals consolidate into one customer-level invoice for the period.          |
| B-004  | Customer code uniqueness shall be scoped to the operator.                                             | Critical     | Same code is permitted across operators but rejected twice within one operator.              |
| B-005  | The system shall preserve VC assignment history when a VC number is reused.                           | Critical     | Historical charges remain with the prior customer and do not transfer to the new assignment. |
| B-006  | Billing shall use calendar months and automatically generate monthly bills on the first day.          | Critical     | A period is billed once; safe retries do not duplicate charges.                              |
| B-007  | Rental plan changes and status changes shall have explicit effective-date rules.                      | Critical     | Current-period billing is predictable and issued invoices are not silently rewritten.        |
| B-008  | Outstanding arrears shall remain due when a VC is suspended or disconnected.                          | Critical     | Past dues stay on the customer account.                                                      |
| B-009  | Payments shall be recorded at customer level and support partial settlement.                          | Critical     | Payment can be allocated across invoices and customer VCs without splitting the account.     |
| B-010  | Payments shall be allocated to the oldest outstanding invoice first by default.                       | Critical     | Allocation order is deterministic and auditable.                                             |
| B-011  | Overpayments shall be retained as customer credit.                                                    | Critical     | Excess amount is visible and not lost or treated as a duplicate payment.                     |
| B-012  | Linemen shall be able to record collections from any customer within their operator.                  | Critical     | No fixed-customer assignment is required to accept a valid collection.                       |
| B-013  | The Android app shall support offline collection and later synchronization.                           | Critical     | A payment is durably stored locally and posted no more than once.                            |
| B-014  | Cash and UPI shall be tracked as separate payment methods.                                            | Critical     | Reports and collection sessions distinguish the two methods.                                 |
| B-015  | Receipts shall be printable on request and shareable through installed WhatsApp/SMS apps.             | High         | Receipt generation is independent of print/share success; delivery is not falsely asserted.  |
| B-016  | The system shall support daily collection review and cash handover.                                   | High         | Expected cash, handed-over cash, UPI totals and discrepancies are recorded.                  |
| B-017  | The system shall preserve all available relevant history during migration.                            | Critical     | Source identifiers, exception lists and financial reconciliation are retained.               |
| B-018  | The service shall use a flat monthly subscription with unlimited customers.                           | High         | Subscription state and renewal/access policy are manageable.                                 |
| B-019  | Basic receipts shall be available initially, with extensibility for future tax-compliance features.   | High         | Core receipt data is available without representing the product as statutory tax invoicing.  |
| B-020  | Sensitive business changes and financial events shall be auditable.                                   | Critical     | Actor, time, action and related entity can be traced.                                        |

## 9. Business policies and decisions

| Topic             | Policy for MVP                                                                                                                                     | Business rationale                                                      |
|-----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| Billing period        | Calendar month; scheduled run on day 1.                                                                                                                | Aligns with current business expectation and simplifies monthly reporting.  |
| Plan change           | Immediate plan change applies the full new monthly rental in the current month. If invoice is already issued, use an auditable adjustment/rebill path. | Avoids ambiguous proration while preventing duplicate charges.              |
| Disconnection         | Stops rental from the following month; past dues remain.                                                                                               | Provides a clear cut-off and preserves historical obligations.              |
| Temporary suspension  | Stops future rental according to an agreed next-eligible-period rule; issued invoices are not automatically rewritten.                                 | Avoids retroactive financial changes.                                       |
| VC reuse              | New assignment identity on reissue; no overlapping active assignment for same operator/number.                                                         | Protects history and prevents cross-customer charges.                       |
| Payment allocation    | Oldest outstanding invoice first; partial allocation permitted.                                                                                        | Makes collection handling consistent and explainable.                       |
| Excess payment        | Retain as customer credit; apply according to the approved credit policy.                                                                              | Prevents loss of customer funds.                                            |
| UPI                   | Record UPI as a method and reference; reference text alone is not verification.                                                                        | Avoids falsely representing a transfer as confirmed.                        |
| Offline receipt       | Provisional local reference until server sync assigns permanent receipt number.                                                                        | Allows field workflow without connectivity while preserving final identity. |
| Receipt delivery      | WhatsApp/SMS app launch is not delivery confirmation.                                                                                                  | Prevents inaccurate customer-service and audit claims.                      |
| Financial corrections | Use reversals/adjustments; do not delete posted payments or silently edit issued invoices.                                                             | Maintains an explainable audit trail.                                       |
| Tax handling          | Simple receipts in MVP; statutory tax invoice compliance is a later, separately reviewed scope.                                                        | Keeps launch scope focused without blocking future extensibility.           |
| Subscription          | Flat monthly subscription; unlimited customer records.                                                                                                 | Simple commercial model for small and mid-sized operators.                  |

## 10. Business process flows

### 10.1 Monthly billing

1.  The system identifies the target calendar month and the eligible VC assignments for each operator.

2.  The system calculates rental line items per assignment and consolidates them by customer.

3.  Prior unpaid amounts and approved ledger adjustments are reflected in the amount due.

4.  The system issues one canonical invoice per customer for the period and records the billing-run outcome.

5.  Authorized staff review exceptions and may retry failed records without duplicate billing.

### 10.2 Field payment collection

1.  The lineman identifies the customer and checks the displayed balance and last-sync status.

2.  The lineman enters the collected amount, payment method and optional UPI reference/notes.

3.  The app saves the payment locally first when offline, or posts to the server when online.

4.  The system allocates funds oldest-first, retains excess as credit and creates a receipt identity.

5. The lineman can print or prepare a digital receipt independently of the payment save.

### 10.3 Daily collection reconciliation

1. The app aggregates the lineman's payments for the business day by method.

2. Cash expected is compared with cash handed over; UPI totals remain separately visible.

3. The lineman enters discrepancies and an explanation where needed.

4. Office staff review, accept or return the reconciliation for correction; finalization is audited.

### 10.4 VC disconnection and reuse

1. Authorized staff records disconnection and effective date on the existing assignment.

2. The old assignment and all related invoice lines remain historically accessible.

3. Future rental stops from the following month under the MVP rule.

4. On reuse, the same VC number is assigned through a new assignment record to the new customer.

5. The system prevents overlapping active assignment periods and does not transfer old dues or payments.

### 10.5 Legacy migration

1. Source schema and business semantics are documented, including plan/recharge relationships and password format.

2. A dry run imports data into a non-production target and generates row-level exceptions.

3. Business and finance owners compare per-operator counts, balances, invoice totals and payment totals.

4. Source writes are frozen for final migration; final import and reconciliation are completed.

5. Production cutover proceeds only after sign-off; source remains read-only and backed up for an agreed period.

## 11. Business rules catalogue

| ID  | Rule                                                                                              |
|---------|-------------------------------------------------------------------------------------------------------|
| RULE-01 | Operator identity is based on immutable internal ID, not display name.                                |
| RULE-02 | Customer code is unique within one operator only.                                                     |
| RULE-03 | One customer may own multiple VCs; each VC assignment has its own rental.                             |
| RULE-04 | Invoice is consolidated at customer level for each calendar month.                                    |
| RULE-05 | No more than one canonical invoice per customer per billing period.                                   |
| RULE-06 | A VC number cannot have overlapping active assignments within an operator.                            |
| RULE-07 | VC reuse creates a new assignment identity; no historical charge transfer.                            |
| RULE-08 | Disconnection stops future rental from the following month; arrears remain due.                       |
| RULE-09 | Suspension affects future eligible billing periods only under the approved effective-date rule.       |
| RULE-10 | Plan changes after issue use a controlled adjustment/rebill process.                                  |
| RULE-11 | Payment can partially settle one or more invoices.                                                    |
| RULE-12 | Oldest outstanding invoice is allocated first by default.                                             |
| RULE-13 | Excess payment becomes customer credit.                                                               |
| RULE-14 | Cash and UPI are separate collection methods and report totals.                                       |
| RULE-15 | A UPI reference entered by a user is not proof of transaction verification.                           |
| RULE-16 | Offline payment is pending server posting until synchronization succeeds.                             |
| RULE-17 | Provisional offline receipt reference must remain linked to the permanent receipt.                    |
| RULE-18 | Share/print action failure cannot reverse a saved payment.                                            |
| RULE-19 | Opening an installed messaging app does not prove a message was sent or delivered.                    |
| RULE-20 | Posted financial records are corrected through linked reversal/adjustment, not deletion.              |
| RULE-21 | Migration does not invent missing transaction or assignment history.                                  |
| RULE-22 | Customer/financial data remains tenant-scoped in reports, exports, receipt links and support tooling. |

## 12. Business data and reporting needs

| Report / view            | Business question answered                                                   | Core filters / dimensions                            |
|------------------------------|----------------------------------------------------------------------------------|----------------------------------------------------------|
| Operator dashboard           | How is the business performing today and this month?                             | Business date, period, area, lineman.                    |
| Customer account statement   | What was charged, paid, adjusted and remains due?                                | Customer, period, invoice, payment.                      |
| Outstanding dues / ageing    | Who owes money and how long has it been outstanding?                             | Ageing bucket, area, amount, customer.                   |
| Invoice register             | Which bills were issued and what is their status?                                | Period, customer, status, amount.                        |
| Payment register             | What payments were recorded, by whom and by which method?                        | Date, collector, method, reference, sync/posting status. |
| Daily lineman collections    | How much cash and UPI did each lineman collect?                                  | Lineman, business date, payment method.                  |
| Cash handover reconciliation | Does the cash handed over match expected cash?                                   | Lineman, session, expected/actual cash, discrepancy.     |
| Billing run report           | Which customers were billed, skipped or failed and why?                          | Operator, period, run ID, status/reason.                 |
| VC status / rental report    | Which connections are active, suspended or disconnected and what rental applies? | Area, status, plan, effective date.                      |
| Migration reconciliation     | What was migrated, transformed, skipped or flagged?                              | Source table, operator, entity, exception category.      |

## 13. Data migration business requirements

- Preserve the original operator identity and mapping even where names are duplicated.

- Preserve available customer, VC, invoice, ledger, lineman, plan and recharge-related history.

- Keep source primary keys as legacy references for traceability.

- Reconcile both row counts and financial totals; counts alone are not sufficient.

- Explicitly review invoices with missing customer references and records whose parent records do not exist.

- Treat zero/invalid dates and unknown status values as exceptions requiring documented mapping.

- Confirm whether source money fields represent rupees or another unit; do not assume based only on data type.

- Resolve legacy password format before attempting credential migration; use secure reset if format is unsupported.

- Document data that cannot be migrated faithfully due to missing historical detail.

- Retain a read-only, backed-up legacy source for an agreed post-cutover period.

| Legacy entity | Known baseline            | Business validation                                                                      |
|-------------------|-------------------------------|----------------------------------------------------------------------------------------------|
| operator          | 8 records                     | Keep op_id as tenant mapping; do not merge duplicate names.                                  |
| costumer          | 7,616 records                 | Review duplicate codes within each operator and nullable operator IDs.                       |
| vc                | 7,334 records                 | Review customer references, zero dates, status meaning and missing assignments.              |
| invoice           | 146,224 records               | Review nullable/orphan customer references, isReceipt semantics, recharge and lineman links. |
| ledger            | 7,334 records                 | Reconcile float amounts and relation to VC balance/due fields.                               |
| lineman           | 134 records                   | Review isDeleted, tenant mapping, login uniqueness and password/token handling.              |
| plan / recharge   | Definition and counts pending | Required before final mapping and migration sign-off.                                        |

## 14. Risks, assumptions and constraints

| Type   | Item                                                                                | Business response                                                              |
|------------|-----------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| Risk       | Legacy data may contain orphans, duplicated display values or missing history.          | Use exception reporting and signed reconciliation; do not silently fabricate data. |
| Risk       | Float-based legacy balances may not exactly match fixed-precision target amounts.       | Agree rounding tolerance and explain every discrepancy.                            |
| Risk       | Connectivity interruptions can lead to duplicate collections if sync is not idempotent. | Require UUID idempotency keys and durable local storage.                           |
| Risk       | Message handoff may be mistaken for delivery.                                           | Use accurate status labels and avoid provider-delivery claims.                     |
| Risk       | Different Bluetooth printers behave differently.                                        | Test and publish supported models/protocols before rollout.                        |
| Assumption | The business wants monthly rental by calendar month rather than anniversary date.       | Treat as confirmed MVP policy unless stakeholders change it.                       |
| Assumption | A lineman can collect from any customer in their own operator.                          | No fixed customer assignment constraint.                                           |
| Assumption | The target will be a hosted SaaS product with a monthly subscription.                   | Operator data is hosted centrally with strict tenant isolation.                    |
| Constraint | MVP receipt is not a claim of full statutory GST invoice compliance.                    | Obtain professional tax/compliance review before expanding invoicing scope.        |
| Constraint | No provider messaging integration is included in MVP.                                   | Use installed Android apps and accurately track only observable handoff states.    |

## 15. Business acceptance and sign-off

| Acceptance area   | Required sign-off evidence                                                                 | Approver                             |
|-----------------------|------------------------------------------------------------------------------------------------|------------------------------------------|
| Billing rules         | Examples covering normal month, plan change, suspension, disconnection, arrears and retry.     | Operator representative / product owner. |
| Payment accounting    | Partial payment, oldest-first allocation, excess credit, reversal and duplicate-sync tests.    | Business owner / finance representative. |
| Field workflow        | UAT on target Android devices with offline mode, sync recovery, printer and app handoff.       | Lineman representative / operations.     |
| Migration             | Per-operator record counts, invoice/payment totals, opening balances and exception acceptance. | Business owner / migration lead.         |
| Tenant security       | Cross-tenant access tests and support-access policy review.                                    | Product/security owner.                  |
| Operational readiness | Backup restore, monitoring, billing failure alert, incident runbook and rollback plan.         | Operations / engineering lead.           |
| Commercial readiness  | Subscription renewal/grace/suspension policy and customer support workflow.                    | SaaS owner.                              |

## 16. Open business decisions

| Decision needed                | Recommended baseline                                                                             | Why it matters                                                |
|------------------------------------|------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| Suspension timing                  | Suspension stops rental from the next eligible billing period; no silent rewrite of issued invoices. | Determines charges for mid-month suspension.                      |
| Plan change after bill issue       | Post a debit/credit adjustment or controlled rebill, retaining the issued invoice.                   | Avoids duplicate or invisible changes.                            |
| Customer credit application        | Apply available credit to oldest outstanding invoices by default, with clear ledger entries.         | Defines how overpayments reduce future dues.                      |
| Invoice number format              | Tenant-specific sequence, unique and immutable.                                                      | Avoids collisions across operators and supports customer service. |
| Subscription grace period          | Set a clear grace window and define whether expired tenants become read-only or suspended.           | Affects collections, access and customer trust.                   |
| Initial UI language                | Choose language(s) based on operator and lineman field testing; keep localization-ready.             | Impacts adoption and training.                                    |
| Supported Android/printer list     | Select target Android versions and a short tested printer list.                                      | Reduces field support failures.                                   |
| Receipt preview expiry             | Set default expiry and a process for revocation/reissue.                                             | Balances convenience and customer-data privacy.                   |
| Tax compliance                     | Define minimum receipt fields now; commission professional review before GST invoice scope.          | Avoids implying statutory compliance prematurely.                 |
| Migration rounding tolerance       | Agree rupee/paise conversion and reconciliation tolerance after profiling source data.               | Necessary for finance sign-off.                                   |
| Support SLA and incident ownership | Define response expectations, billing-job escalation and tenant support authorization.               | Ensures ongoing business continuity.                              |

## 17. Implementation approach and business rollout

| Stage             | Business activity                                                                      | Exit criteria                                             |
|-----------------------|--------------------------------------------------------------------------------------------|---------------------------------------------------------------|
| Discovery             | Confirm business policies, legacy meanings, devices, languages and subscription lifecycle. | Decisions documented and owners assigned.                     |
| Build and internal QA | Implement core records, billing, payments, reports and Android collection.                 | Critical workflows pass acceptance tests.                     |
| Pilot                 | Select a small number of operators and field users; validate real collections and billing. | No unresolved critical financial or tenant-isolation defects. |
| Migration rehearsal   | Import snapshot, compare balances, train staff and practice rollback.                      | Business signs reconciliation and cutover plan.               |
| Cutover               | Freeze legacy writes, final sync, verify live totals and enable production.                | Formal sign-off from business and engineering.                |
| Stabilization         | Monitor billing jobs, payment sync, support tickets and reconciliation exceptions.         | Stable operation and handover to support.                     |

## 18. Approval record

| Role                          | Name | Decision / comments | Date |
|-----------------------------------|----------|-------------------------|----------|
| Business owner                    |          |                         |          |
| Product owner                     |          |                         |          |
| Engineering lead                  |          |                         |          |
| Finance / operator representative |          |                         |          |
| Operations / support              |          |                         |          |
