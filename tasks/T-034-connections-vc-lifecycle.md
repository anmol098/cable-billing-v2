---
id: T-034
title: Connections (VC) lifecycle
phase: 1
area: web
status: done
owner: agent-t034
claimed_at: 2026-10-13T19:47:14.429Z
branch: task/T-034-connections-vc-lifecycle
depends_on: [T-033]
review: self
claimable_by: agent
size: L
paths: [packages/core/src/connections/**, apps/web/src/app/(operator)/customers/[id]/connections/**, apps/web/src/app/(operator)/customers/new/_steps/connections/**, packages/i18n/messages/*/connections.json]
---

# T-034 — Connections (VC) lifecycle

**Phase** 1 · **Area** web · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-033

## Goal

Add VCs to customers and change their status with effective dates, keeping full history.

## Scope

- Services: add assignment (find-or-create VC asset, plan or custom amount, start date), suspend, reactivate, disconnect (effective date, reason), reassign a disconnected VC to a new customer (new assignment), timeline query.
- Emits domain hooks `onAssignmentStarted/Reactivated/PlanChanged` (no-op default) that T-045 implements for adjustments.
- UI: Connections tab with timeline, status actions via ConfirmSheet with plain-language effect ('Rent stops from November. ₹450 old due stays.'), stepper step 2 in add-customer.
- Effective-date rules: Staff cannot back-date into an already-billed period (Owner flow handled in T-045).

## Acceptance criteria

- [x] VC reuse keeps old assignment and charges with the old customer (PRD §15 #6).
- [x] Invalid transitions (e.g. reactivate a disconnected assignment) are rejected.

## Tests required

- Service tests for every transition; isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/connections/**`
- `apps/web/src/app/(operator)/customers/[id]/connections/**`
- `apps/web/src/app/(operator)/customers/new/_steps/connections/**`
- `packages/i18n/messages/*/connections.json`

## References

FR-005, FR-006, BR-03, BR-04, RULE-06, RULE-07, J-02, J-06, PLAN §8.1 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/connections/services.ts` | Writes. `addConnection` (`connections.add`, `customers.manage`), `suspendConnection` / `reactivateConnection` / `disconnectConnection` (`connections.suspend` / `.reactivate` / `.disconnect`, `connections.status.change`), `changeConnectionPlan` (`connections.change_plan`, `customers.manage`), `createCustomerWithConnections` (`customers.create_with_connections`, `customers.manage`). In-transaction versions for composite callers: `addConnectionInTx`, `changeStatusInTx`, `changePlanInTx` (all take `ConnectionWriteOptions { allowBilledPeriod }`). `isVcOverlapConflict(err)`. |
| `packages/core/src/connections/queries.ts` | Reads (READ ONLY tx). `listConnections` (`connections.list`, `customers.view`): the Connections tab data. `connectionFormOptions` (`connections.form_options`, `dashboard.view`): active plans, today, latest start date, and (with a `customerId`) the earliest start date. |
| `packages/core/src/connections/rules.ts` | Pure: `nextStatus`, `allowedActions`, `eventTypeOf`, `rentStopsFrom`, `billedFrom`, `isMidMonth`, `reachesBilledPeriod`, `earliestAllowedDate`, `changeDateProblem`, `startDateProblem`, `latestStartDate`, `formatStopReason` / `parseStopReason`, `STOP_REASONS`, `CONNECTION_ACTIONS`, `CONNECTION_LIMITS`, `MAX_START_DAYS_AHEAD` (1), `EARLIEST_BUSINESS_DATE`, `VC_NUMBER_PATTERN`. |
| `packages/core/src/connections/hooks-contract.ts`, `hooks/index.ts` | The hooks contract (types) and **no-op defaults** `connectionHooks` (T-045 owns `hooks/**` and replaces them). |
| `packages/core/src/connections/store.ts` | Internal row helpers and the lock order (customer `FOR NO KEY UPDATE` → `customer_balances` via T-046 `lockCustomerBalance` → VC asset `FOR UPDATE` → assignment `FOR UPDATE`), `latestBilledPeriod`, find-or-create VC, T-022 row → T-040 timeline mapping. |
| `packages/core/src/connections/connections.isolation.ts` | 12 isolation cases (every service; `not_found` for customer, assignment, plan and area ids; `no_leak` for the plan list). |
| `apps/web/src/app/(operator)/customers/[id]/connections/**` | The Connections tab: a card per connection (VC number, Active/Stopped/Removed pill, rent, plan, since/from–to, "Still on today. Stops from tomorrow."), Stop / Start again / Remove (ConfirmSheet with "From which day?", reason, and the effect: "Rent stops from November 2026. ₹450 old due stays. The box can go to another customer from 15 Oct 2026."), "What happened" timeline (date, event, reason, by whom), "Old connections"; "Add connection" (`?add=1`) as the page's primary action. `_parts/` holds the client-safe form state, the server error mapping, the effect helper and the shared `ConnectionFields`. |
| `apps/web/src/app/(operator)/customers/new/_steps/connections/**` | Step 2 of "Add customer" (one VC: number, plan or own amount, start day; empty VC = no connection now), its line on Check & save, and `createCustomerWithConnectionAction` (customer + connection in one transaction; a VC problem goes back to step 2, a customer problem to step 1). |
| `packages/i18n/messages/{en,hi}/connections.json` | Namespace `connections` (102 keys; all Hindi in `_review` except `form.plan_option`). Glossary: new "Connection words (web, T-034)" table. |
| `packages/design-tokens/icons.json` | Three meanings: `pause` (circle-pause), `resume` (circle-play), `disconnect` (unplug); generated web icon data + Android `ic_cb_*.xml`. |

**Service API (T-045, T-060, T-084, T-092)**

- `addConnection.call(rt, ctx, { customerId, vcNumber, planId? | rentalPaise?, startDate })` → `{ connection: ConnectionView, vcAssetCreated, previous: { assignmentId, customerId, endDate } | null }`. Exactly one of `planId` (active plan; its amount is copied, FR-007) and `rentalPaise` (own amount, 0 … ₹1,00,000). The VC is found by its normalised number (T-022) or created. Reuse = adding a removed VC to another customer: a **new** assignment; the old row is never touched.
- `suspendConnection` `{ assignmentId, effectiveDate, reason?, note? }`, `reactivateConnection` `{ assignmentId, effectiveDate }`, `disconnectConnection` `{ assignmentId, effectiveDate, reason, note? }` (reason required) → `{ connection, eventId, changed: true }`. Removal sets `end_date` = effective date. `reason` ∈ `STOP_REASONS`; stored as `code` or `code: note` (`parseStopReason` reads it back, also free text from migrated rows).
- `changeConnectionPlan` `{ assignmentId, effectiveDate, planId? | rentalPaise? }` → same shape; the same plan + amount again → `changed: false`, no event, no audit row. **Its screen is T-045's** (`_plan-change/**`).
- `createCustomerWithConnections` `{ customer: CreateCustomerInput, connections: ConnectionFields[] (≤ 10) }` → `{ customer, autoCode, connections }`; a connection's error carries `details.connectionIndex` and field paths `connections.<i>.<field>`.
- `listConnections` `{ customerId }` → `{ customerId, customerActive, today, latestBilledPeriod, current[], past[] }`; each `ConnectionDetail` has `status` (after the latest change), `statusToday` (T-040 `assignmentStatusOn`), plan name, rent, dates, `historyLimited`, `actions` (allowed now), `earliestChangeDate`, and `events[]` (type, effective date, recorded `at`, parsed reason, actor name, plan-change from/to names and rents). Lineman may read it (`customers.view`) — **T-060** can use it for the roster/customer detail.
- `connectionFormOptions` `{ customerId? }` → `{ plans, today, latestStartDate, earliestStartDate }`.
- Refusals (nothing written): NOT_FOUND for another tenant's / unknown ids; VALIDATION `details.fields[{path, code}]` (`planId`/`custom` = plan or amount missing/both, `planId`/`retired`, `vcNumber`/`custom`, `startDate`|`effectiveDate`/`in_future`|`too_old`|`before_start`|`before_last_change`); CONFLICT `details.reason`: `invalid_transition` (`from`, `action`), `customer_closed`, `vc_retired`, `vc_in_use` (`holderCustomerId`, `holderCustomerCode`, `holderName`, `holderStatus`, `until`, `earliestStart`, `sameCustomer`; the EXCLUDE constraint is the race backstop with `details.constraint = "vc_assignments_no_overlap"`), `billed_period` (`field`, `period`, `earliestDate`). Lineman → FORBIDDEN; read-only tenant → TENANT_READ_ONLY.
- Every write: one audit event (`vc_assignment`; actions `connections.add|suspend|reactivate|disconnect|change_plan`), one `assignment_events` row (actor, `at` = the call's clock), `customers.updated_at` bumped (roster cursor, PLAN §10.3).

**Hooks contract (T-045)** — `connectionHooks.onAssignmentStarted(hc, { assignment, eventId, effectiveDate })`, `onAssignmentReactivated(hc, { assignment, eventId, effectiveDate })`, `onAssignmentPlanChanged(hc, { assignment, eventId, effectiveDate, fromPlanId, toPlanId, fromRentalPaise, toRentalPaise })`, each `→ Promise<Result<void, ServiceError>>`. `hc = { tx, ctx, now, today, audit, log }`. Called in the same transaction after the assignment and event rows are written, **with the customer, `customer_balances` and VC locks held** (so adjustments are serialised with payments and the billing run, as T-044 asks). `err` rolls back the whole change. The months after `periodOf(effectiveDate)` were checked not to be billed (unless `allowBilledPeriod`), so the hook only decides `periodOf(effectiveDate)` (T-042 `midMonthStartForPeriod` / `planChangeForPeriod`). The **Owner's back-dated flow** can call `changeStatusInTx` / `changePlanInTx` / `addConnectionInTx` with `{ allowBilledPeriod: true }` after/before creating its adjustment in the same transaction (tested with a stand-in service).

**Decisions (please check)**

1. **"Already billed" for a customer** = month P has a regular invoice for the customer, **or** P's billing run already looked at the customer and decided (`created`, `already_exists`, or `skipped` = nothing to bill). A `failed` item is not billed (its retry re-reads the state). A customer added after the run has no billed month for it.
2. **Back-dating rule** (PLAN §8.3): a change effective D may only alter D's own month (the T-045 hook's job) and later months; if any month **after** D's month is already billed for the customer the change is refused with `billed_period` — for **Staff and, until T-045's guided flow, the Owner too** ("prevents silent rewrites of history"). In words: the earliest allowed day is the 1st of the customer's latest billed month. Starts, stops, starts again, removals and plan changes all follow it.
3. **Dates**: status/plan changes never in the future, never before the start or the latest change (so events stay in date order and `status` = the latest event); same-day stop + start again is allowed. Starts may be at most **tomorrow**: a VC removed today can start at the next customer tomorrow (T-022's inclusive `'[]'` range; same-day reuse is refused with "It can start here from 14 Oct"; see Q-1).
4. A **stopped VC is still its customer's** (T-022 decision 2): only a removal frees it.
5. **No connection on a closed customer** (`customer_closed`); the customer row lock makes this race-free against T-033's close.
6. Effect text is computed client-side from `@cb/domain` (a unit test keeps it equal to `@cb/core`'s rules): Stop/Remove "Rent stops from {month after D's month}", "₹X old due stays" (customer balance > 0), Remove "The box can go to another customer from {D+1}", Start again "Rent starts again from {month after D's month}". **T-045** should extend `_parts/effect.ts` when its hook charges D's own month (`charge_full_month`).
7. Stop/remove reasons are a fixed list (`not_paying`, `customer_asked`, `moved_away`, `box_problem`, `other` + note); a stop's reason is optional, a removal's required.
8. "Add customer" step 2 takes **one** connection (PLAN §12.2: ≤ 6 fields per step); more are added on the tab. The service accepts up to 10.
9. The Connections tab's primary action is "Add connection" (not "Take payment") for Owner/Staff.

**Open questions**

- Q-1 (T-022 Q-A, product owner): allow same-day VC reuse? Today the next customer can start the day after the removal.
- Q-2: should Staff see a "ask the owner" path for back-dated changes (today the message says so; T-045 builds the Owner flow)?
- Q-3: T-040 Q-1 still applies: a reactivation effective the 1st is not billed by that month's run; the effect text says "Rent starts again from {next month}" accordingly.
- Q-4: Hindi in `connections.json` `_review` (H-03), esp. "किराया" for rent, "हटाएँ" for Remove.

**Deviations / files outside the owned paths**

- `packages/core/src/index.ts` (one export line), `packages/i18n/glossary.md` (new section), generated `apps/web/messages/*.json`.
- `packages/design-tokens/icons.json` + generated `packages/ui/src/icons/icons.generated.ts` and three Android drawables (new meanings `pause`, `resume`, `disconnect`; HANDOFF: "add a meaning to icons.json and run pnpm icons:build").
- T-033 (done), smallest changes: `customers/new/add-customer-form.tsx` (`connectionsStep` may be a function of the state; new `connectionsCheck` slot for step 3; after a failed save it goes back to `state.step ?? 0`), `customers/_components/form-state.ts` (optional `step`), `customers/new/page.tsx` (uses the T-034 wrapper and action). T-033's `createCustomerAction` is no longer used by the page (left in place).
- T-029 / T-033 e2e `apps/web/e2e/shell.spec.ts`: the connections tab's title is now the customer's name (like the Summary). New `apps/web/e2e/connections.spec.ts` (T-088's folder, as T-033 did).
- `plan change` service is here (T-022 notes assign it to T-034; its hook is in scope); its UI is T-045's.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core`: 50 files / 704 tests passed (1 skipped benchmark). New: `rules.test.ts` (33: transition table, effect months, back-dating, date rules, reasons), `connections.test.ts` (16: add with plan/own amount/₹0/tomorrow, field-by-field refusals with nothing written, closed customer, lineman FORBIDDEN, read-only, VC in use with holder details (also stopped), same number at another tenant, hook error rolls back; stop → start again → stop → remove with events/audit/valid T-040 timeline; every invalid transition rejected incl. **reactivate a removed connection**; date rules; reason required; plan change + no-op repeat + hook args; add customer with connections, refused VC saves nothing; timeline/statusToday/actions; form options), `history.test.ts` (4, real T-044 billing run: **VC reuse** — Ramesh's Oct invoice line, payment, balance and old assignment unchanged, Suresh billed only for the new assignment in Nov with opening 0, both ledgers pass `checkLedger`; back-dating refused for Staff and Owner, allowed inside the billed month, via `allowBilledPeriod`, for plan changes and starts, for a customer the run skipped; allowed for a newcomer), `concurrency.test.ts` (3, parallel pool: 6 customers race for one new VC → exactly one wins, one asset; removal racing adds → never overlapping; stop/start/remove racing on one assignment → valid history, status = last event), isolation (12 cases) + coverage.
- Mutation check (reverted): counting only `created`/`already_exists` items as billed fails the "skipped counts as billed" test.
- `@cb/web`: 24 files / 229 tests (new `connections.test.tsx`, 19: effect text = core rules, en/hi months, input parsing, error mapping incl. `connections.0.*` paths, fields, Stop/Remove/Start again sheets, Hindi, add-customer step 2 + check + error back to step 2; T-033's form tests unchanged and passing).
- Playwright against `next start` (scratch DB `cb_e2e_t034`, `E2E_PORT=3234`, pre-installed Chromium): **59 passed**, 2 new in `connections.spec.ts` (add customer with a VC in 3 steps → tab → stop → start again → remove (reason required) → reuse on another customer refused today with "until … from …", accepted from tomorrow → old connection stays on the old customer; 360px no sideways scroll; other tenant / made-up ids 404).
- Screenshots (desktop + 360px, en + hi: tab, sheets, step 2/3) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`, `i18n:build --check`, `openapi:build --check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T19:47:14.430Z claimed by agent-t034
- 2026-10-13T20:25:38.025Z completed on task/T-034-connections-vc-lifecycle
