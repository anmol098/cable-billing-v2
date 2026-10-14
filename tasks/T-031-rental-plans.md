---
id: T-031
title: Rental plans
phase: 1
area: web
status: done
owner: agent-t031
claimed_at: 2026-10-14T04:47:40.053Z
branch: task/T-031-rental-plans
depends_on: [T-029, T-022, T-025]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(operator)/settings/plans/**, packages/core/src/plans/**, packages/i18n/messages/*/plans.json]
---

# T-031 — Rental plans

**Phase** 1 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-029, T-022, T-025

## Goal

Owner creates, edits and retires monthly rental plans.

## Scope

- List, create, edit (name/amount), retire/unretire.
- Editing a plan amount asks: 'Apply to existing connections from next month?' (bulk plan-change is out of scope; just show count of connections on this plan).

## Out of scope

- Changing a connection's plan (T-045).

## Acceptance criteria

- [x] Issued invoices are unaffected by plan edits (covered by schema; add a test).
- [x] Retired plans cannot be assigned to new connections.

## Tests required

- Service tests + isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/plans/**`
- `packages/core/src/plans/**`
- `packages/i18n/messages/*/plans.json`

## References

FR-007, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (all exported from `@cb/core`)

| Where | What |
|---|---|
| `packages/core/src/plans/plans.ts` | `listPlans` (`plans.list`, `dashboard.view`: Owner + Staff; input `{ includeRetired?: boolean = true }`) → `PlanListView { plans: PlanView[], editable, readOnlyReason }`, active plans first, then retired ones, each by amount then name. `PlanView { id, name, monthlyAmountPaise, status: "active" \| "retired", connectionCount }` (current connections on the plan: active or stopped, not removed). `createPlan` `{ name, monthlyAmountPaise }` → `PlanView`; `updatePlan` `{ planId, name, monthlyAmountPaise }` → `PlanUpdateResult { plan, changed: ("name" \| "monthly_amount_paise")[] }`; `retirePlan` / `restorePlan` `{ planId }` → `PlanView` (all four `plans.manage`: Owner only, audited, refused in read-only mode). Helpers `plansAccess(tx, ctx)` (like T-030's `settingsAccess`, but on `plans.manage`), `PlanName` (1–60 chars, spaces collapsed, no control characters), `PlanAmountPaise` (integer paise, whole rupees, 0 … ₹1,00,000), `PLAN_NAME_MAX`, `PLAN_AMOUNT_MAX_PAISE` (= T-034 `CONNECTION_LIMITS.maxRentalPaise`). |
| `packages/core/src/plans/plans.isolation.ts` | 7 cases: change price / rename / retire / restore another tenant's plan → NOT_FOUND with no DB change; list (both modes) and create → `no_leak`. |
| `apps/web/src/app/(operator)/settings/plans/**` | Page (replaces T-029's placeholder), `PlansManager` (list: rent first, name, connections, "Hidden"; Owner: "Add plan" in the header, "Change", "Hide" (ConfirmSheet) / "Show again"), the plan dialog (name + whole-rupee `AmountInput`; a rent change on a plan with connections first shows "Change the rent to ₹300?" with the count), 4 Server Actions, `action-state.ts` (error → words, `MAX_PLAN_PAISE`). |
| `packages/i18n/messages/{en,hi}/plans.json` | Namespace `plans` (45 keys; all Hindi in `_review`). The read-only notice reuses T-030's `settings.read_only.*`. Glossary: new "Plan words" table. |
| `apps/web/e2e/plans.spec.ts` | Playwright flow (T-088's folder, as T-030/T-034 did). |
| `tasks/T-031a-…md` | Follow-up: apply a plan's new rent to its connections (needs a product-owner decision and T-045). |

**For T-045 / T-084 / T-092 / T-083:** pickers can call `listPlans.call(rt, ctx, { includeRetired: false })` (T-034's `connectionFormOptions` already lists active plans). Active names are unique ignoring capitals and outer spaces (T-022 index), so an import can match a plan by `lower(btrim(name))` among active plans. The setup checklist's "Add your rental plans" step (T-083) can use `listPlans` (`plans.length > 0`).

**How a price change works (checked against T-034 and T-044)**

- A connection copies the plan's amount into `vc_assignments.rental_amount_paise` when it gets the plan (T-034 `resolveRental`), and the billing run reads that copy (T-044 `billing/inputs.ts`) and copies it again into `invoice_lines`. So editing a plan never changes a bill already made, **and also does not change what the plan's existing connections pay**: only connections that get the plan after the edit pay the new rent, from their first bill. This is what FR-007 and the T-022 schema comment say ("applying a new amount to existing connections is an explicit plan change per connection (T-045), never a side effect of editing the plan").
- The page therefore does not offer "Apply to existing connections from next month?" as a working choice (bulk plan change is out of scope): before saving a new rent on a plan that has connections it asks "Change the rent to ₹300?" and says "1 connection is on this plan. It keeps paying ₹250 a month. Connections you add from now pay ₹300. Bills already made do not change. To change the rent of one connection, open the customer and change its plan." The bulk "from next month" step is T-031a.
- Tested with the real services: Oct bill made at ₹250 → price raised to ₹300 → the October invoice rows and lines are byte-for-byte unchanged, the existing connection still has ₹250 and is billed ₹250 in November, a connection added after the change gets ₹300 and is billed ₹300.

**Decisions**

1. **No delete** (the DB forbids it, T-022): "Hide" retires a plan, "Show again" restores it, the same words and pattern as T-030's areas. A retired plan stays on its connections (and their rent); T-034 refuses it for `connections.add` and `connections.change_plan` (`VALIDATION planId/retired`) and `connectionFormOptions` doesn't offer it (all tested here).
2. Name clash among **active** plans → CONFLICT `details.reason = "name_taken"` (also from the unique index when two saves race: tested with 4 parallel creates → exactly one plan). A new plan may reuse a hidden plan's name ("Basic" ₹250 hidden, new "Basic" ₹300), a hidden plan may be renamed to an active plan's name, and "Show again" is refused while an active plan has its name ("A plan in use already has this name. Change one of the names first.").
3. Amounts are whole rupees in the service too (`multipleOf(100)`, D-17), ₹0 allowed (free connections), at most ₹1,00,000 (same ceiling as T-034's own amount).
4. Saving identical values writes nothing and no audit event (`audit.skip("no_change")`; the page says "Nothing changed"). Audit events (`entity_type = plan`): `plans.create` (name, amount), `plans.update` (only changed fields; a rent change also records `connection_count`, the connections that keep the old rent), `plans.retire` (`connection_count`), `plans.restore`.
5. `connectionCount` counts current connections (active + stopped), not removed ones, so "Hide Basic? Its 12 connections keep it" means connections that still pay it.
6. List order: active first, cheapest first (numbers first, as the connection form's plan picker orders them), then hidden ones.

**Deviations / files outside the owned paths**

- `packages/core/src/index.ts` (+1 export line), `packages/i18n/glossary.md` (new section), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/plans.spec.ts`, new task file `tasks/T-031a-…md`.
- The scope's question "Apply to existing connections from next month?" is shown as information plus a confirm (count + "they keep ₹250"), not as a yes/no that does something, because applying it needs the bulk plan change that is out of scope (T-031a).

**Open questions (product owner)**

- Q-1: Should a plan's new rent be offered for its existing connections (bulk, from next month)? Today they keep the old rent until each connection's plan is changed (T-045's screen). T-031a is written for it.
- Q-2: T-034's `resolveRental` reads the plan without a row lock, so a connection added at the same moment as "Hide" can still get the plan. Harmless (a hidden plan on a connection is a valid state), noted for T-034's owner.
- Q-3: Hindi in `plans.json` `_review` (H-03), esp. "हर महीने का किराया" (Rent each month) and "छिपाएँ" for a plan.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core`: `plans/plans.test.ts` (32: name/amount rules incl. paise and ₹1,00,000+ refused; list order, counts (stopped counted, removed not), Staff `not_owner`, picker mode, read-only reason, lineman FORBIDDEN; create + audit, ₹0, clash any capitals with no DB change, hidden plan's name allowed, other tenant's name allowed, VALIDATION paths; update name/price with exact audit, no-op writes nothing (DB fingerprint), capitals-only rename, clash + unknown id with no DB change, hidden plan may take an active name; retire/restore idempotent with exact audit, restore clash with no DB change, no delete; Staff/lineman FORBIDDEN ×4 and read-only/cancelled/no subscription TENANT_READ_ONLY ×4, DB unchanged; 4 parallel creates → one plan). `plans/bills.test.ts` (2, real T-034 + T-044: price change never touches an issued invoice or existing connections, new connections pay the new price; hidden plan refused for add and plan change, not in the form options, its connection still billed at its rent, and a later price change of the hidden plan doesn't touch it). Isolation suite: the 7 new cases pass; coverage test passes. Whole package: 874 passed, 1 skipped.
- `@cb/web`: `plans.test.tsx` (24: error mapping, field mapping, max = core's; list texts incl. ₹1,00,000 grouping and Hidden; Staff and read-only views without buttons; add with rupees → paise, empty rent, decimal refused as typed, name clash keeps the dialog; rename without asking; rent change asks with the count, Back keeps the typed rent, confirm saves; no question with 0 connections; "Nothing changed"; hide sheet text; show again failure; Hindi). Whole package 361 passed.
- Playwright against `next start` (scratch DB `cb_e2e_t031`, `E2E_PORT=3231`, pre-installed Chromium): `plans.spec.ts` (3) + `shell.spec.ts` + `settings.spec.ts`: 11 passed. Owner: Settings → Plans, add (tidy name, ₹250 → 25000 paise in DB), duplicate refused, rent change asks with "1 connection … keeps paying ₹250", DB has the new price and the connection keeps 25000, hide (sheet text, moves to the end), hidden plan not offered on "Add customer" step 2, show again, audit actions in the DB, 360px no sideways scroll. Staff and read-only Owner: notice, no buttons. Screenshots (desktop, 360px en + hi, confirm dialog) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-14T04:47:40.054Z claimed by agent-t031
- 2026-10-14T05:05:50.566Z completed on task/T-031-rental-plans
