---
id: T-030
title: Settings: business profile and areas
phase: 1
area: web
status: done
owner: agent-t030
claimed_at: 2026-10-13T16:18:54.669Z
branch: task/T-030-settings-business-profile-and-areas
depends_on: [T-029, T-025]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(operator)/settings/profile/**, apps/web/src/app/(operator)/settings/areas/**, packages/core/src/operators/**, packages/core/src/areas/**, packages/i18n/messages/*/settings.json]
---

# T-030 — Settings: business profile and areas

**Phase** 1 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-029, T-025

## Goal

Owner manages business details and areas.

## Scope

- Profile: name, phone (shown on receipts + 'call office' in app), address, receipt footer, invoice prefix, default language, **mid-month start policy** (charge full month / start next month) with plain-language explanation.
- Areas CRUD (rename, archive; no delete when used).
- All changes audited.

## Acceptance criteria

- [x] Only Owner can edit; Staff read-only. (Enforced in the services: `business_profile.manage` is Owner-only → FORBIDDEN for Staff/linemen with nothing written; the pages render a read-only view for Staff and for a read-only tenant's Owner. Tested in core, web components and Playwright.)

## Tests required

- Service tests + isolation harness registration.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/profile/**`
- `apps/web/src/app/(operator)/settings/areas/**`
- `packages/core/src/operators/**`
- `packages/core/src/areas/**`
- `packages/i18n/messages/*/settings.json`

## References

PLAN §12.1, D-18 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (all exported from `@cb/core`)

| Where | What |
|---|---|
| `packages/core/src/operators/profile.ts` | `getBusinessProfile` (`operators.get_profile`, `dashboard.view`: Owner + Staff) → `BusinessProfileView { id, profile, updatedAt, editable, readOnlyReason }`; `updateBusinessProfile` (`operators.update_profile`, `business_profile.manage`: Owner only, audited) with input `UpdateBusinessProfileInput` (`name, phone, address, receiptFooter, invoicePrefix, defaultLanguage, midMonthStartPolicy`, all strings from the form; `""` → null) → `{ id, profile, changed: BusinessProfileField[], updatedAt }`. Helpers `BUSINESS_PROFILE_LIMITS`, `normalizeOfficePhone`, `normalizeInvoicePrefix`, `OFFICE_PHONE_PATTERN`, `INVOICE_PREFIX_PATTERN`. |
| `packages/core/src/operators/access.ts` | `settingsAccess(tx, ctx)` → `{ editable, readOnlyReason: "not_owner" \| "tenant_read_only" \| null }` (T-031 Plans can reuse it for its read-only view). |
| `packages/core/src/operators/text.ts` | `oneLine`, `multiLine`, `hasNoControlCharacters` + Zod builders `requiredLine(max)`, `optionalText(max)`. |
| `packages/core/src/areas/areas.ts` | `listAreas` (`areas.list`, `dashboard.view`; input `{ includeArchived?: boolean = true }` → `{ areas: AreaView[], editable, readOnlyReason }`, `AreaView { id, name, archivedAt, customerCount }`, in-use first then hidden, by name); `createArea` `{ name }`, `renameArea` `{ areaId, name }`, `archiveArea` `{ areaId }`, `restoreArea` `{ areaId }` (all `business_profile.manage`, audited, → `AreaView`). `AreaName` (1–60 chars, spaces collapsed), `AREA_NAME_MAX`. |
| `*.isolation.ts` | 8 cases: rename/archive/restore another tenant's area → NOT_FOUND with no DB change; list (both modes), create, get/update profile → `no_leak` (only the caller's rows read/written). |
| `apps/web/src/app/(operator)/settings/profile/**` | Page (Owner: `ProfileForm`; Staff / read-only Owner: `ProfileView`), `saveProfileAction`, `form-state.ts` (error → words), `field.tsx` (`Field`, `FieldNote`, `Notice`, reused by the areas page). |
| `apps/web/src/app/(operator)/settings/areas/**` | Page, `AreasManager` (list, Add area / Change name dialogs, Hide confirm sheet, Show again), 4 Server Actions, `action-state.ts`. |
| `packages/i18n/messages/{en,hi}/settings.json` | Namespace `settings` (`read_only.*`, `profile.*`, `areas.*`). All Hindi in `_review`. Glossary: new "Settings words (web)" table. |
| `apps/web/e2e/settings.spec.ts` | Playwright flow (T-088's folder, as T-026/T-029 did). |

**For T-033 (customers) / T-084 (import) / T-080 (reports):** area pickers should call `listAreas.call(runtime, ctx, { includeArchived: false })` (hidden areas are not offered for new choices; a customer already in a hidden area keeps it, so an edit form should still show that one). Names are unique per operator ignoring case (the T-022 index), so import can match by `lower(name)`.

**Where each setting goes (so edits flow everywhere)**

- **Phone** is written to `settings.office_phone` **and** `operators.phone` (kept equal; clearing clears both). The receipt page (T-050) and `/app/config` (T-028) both read `office_phone`, falling back to `operators.phone`; keeping both equal means the receipt, the app's "Call office" and this page never show two different numbers. Tested: after a save, `mobileAuth.appConfig()` returns the new name, office phone and receipt footer.
- **Invoice prefix** → `settings.invoice_prefix`; the billing run (T-044) reads it via `invoicePrefixOf` when it makes bills (tested). Old bills keep their numbers; the counter is shared, so numbers stay unique across a prefix change. The page says: "Only new bills use it. Bills already made keep their numbers." with a live example (`CB-2610-00001`).
- **Default language** → `settings.default_language`, the language of the receipt link (T-050). The page calls it "Receipt language" (that is what it does today).
- **Mid-month start policy (D-18)** → `settings.mid_month_start_policy`. Plain explanation on the page: *"This month's bills are already made. Then a new connection starts, or a stopped one starts again. Should it pay for this month?"* — **Charge the full month**: the full rent for this month is added to the customer's next bill (a debit bill change, no proration). **Start from next month**: nothing for this month; rent starts with next month's bill. Note: a connection that starts on the 1st before the bills are made is billed by that month's run either way (PLAN §8.1), and a change applies to connections that start after saving (T-045 reads the setting at that moment).
- Unknown keys already in `operators.settings` are preserved on save (tested).

**Decisions**

1. **No delete for areas at all.** Rename fixes a typo; Hide (archive) takes an area out of the pickers with the same effect for the user as deleting an unused one, and is reversible (Show again). Delete would break the audit trail ("Who changed what" names the area id), reports by area and import matching, and an "unused" check races with a customer being added. One destructive button fewer (PLAN §2.2 rule 6).
2. Name clash → CONFLICT `details: { reason: "name_taken", archived }`; the dialog says "A hidden area has this name. Use 'Show again' on it instead." when the clash is a hidden one.
3. Read services return `editable`/`readOnlyReason` so pages pick form vs read-only view; the write services still enforce role (FORBIDDEN) and read-only mode (TENANT_READ_ONLY) themselves.
4. Control characters (ESC, NUL, …) are refused in every field: name/footer go to the lineman's ESC/POS printer (T-068), so a stored ESC byte would be a printer command. Tabs/line ends are normalised; spaces collapsed in one-line fields.
5. Phone accepts what people type (`+91 98765-43210`, `(0712) 255-1234`) and stores digits with an optional leading `+` (T-021 format, 6–19 digits); empty is allowed (then "Call office" has no number — see open question).
6. Saving identical values writes nothing and no audit event (`audit.skip("no_change")`); the audit event lists only changed fields with old/new values (snake_case keys = stored names).
7. One form with three short groups and one Save (pinned above the bottom bar on phones) instead of several forms with several primary buttons.

**Deviations / files outside the owned paths**

- `packages/core/src/index.ts` (+2 export lines), `packages/i18n/glossary.md` (Settings words), generated `apps/web/messages/{en,hi}.json`, new `apps/web/e2e/settings.spec.ts`.
- The profile form has 7 fields (PLAN §12.2 suggests ≤ 6 per step); they are split into three labelled groups on one page.
- `profile.test.tsx` stubs `ResizeObserver` locally (Radix RadioGroup; `apps/web/vitest.setup.ts` lacks it, as `@cb/ui`'s setup has).

**Open questions (product owner)**

- Should the office phone be required? Today it may be empty (then the app's "Call office" has nothing to dial). New sign-ups get the owner's mobile (T-027).
- Changing the bill number start while a billing run is in progress: the next slice of that run uses the new prefix, so one month can show two prefixes (numbers stay unique). Block the change during a run, or accept?
- Should `default_language` also be the starting language of new staff/linemen (T-032)? The page only promises receipts.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `@cb/core`: `operators/profile.test.ts` (33: input normalisation + 15 refusal cases; defaults; Staff read-only, lineman FORBIDDEN; read-only/cancelled/no subscription → `tenant_read_only`; business-phone fallback; full save with both phone columns, settings and the audit row (actor, request id, before/after); changed-fields-only audit + clearing the phone; no-change save writes nothing (DB fingerprint); unknown settings keys kept; VALIDATION with paths only and DB unchanged; Staff/lineman FORBIDDEN with DB unchanged; TENANT_READ_ONLY ×3 with DB unchanged; writable again in grace; **saved values reach `invoicePrefixOf` (T-044) and `appConfig` (T-028)**). `areas/areas.test.ts` (21: name rule; list order/counts/editable, picker mode; create + audit; clash ignoring case incl. hidden areas, nothing written; same name in another tenant; blank; rename + audit, capitals-only rename, no-op; clash/unknown id; archive keeps customers' area, idempotent, restore, exact audit trail; no delete; Staff/lineman FORBIDDEN ×4 with DB unchanged; read-only ×3 → TENANT_READ_ONLY with DB unchanged, reads still OK). Isolation suite: the 8 new cases pass; coverage test passes. Whole package: 41 files / 609 tests.
- `@cb/web`: `profile.test.tsx` (12) and `areas.test.tsx` (18): error mapping, form fields + live bill-number example, submit/field errors in words, saved values + toast, Hindi, read-only views without buttons, add/rename dialogs, hide confirm text with the customer count, failure toast. Whole package 195 tests.
- Playwright (`E2E_PORT=3230`, scratch DB `cb_e2e_t030` migrated, pre-installed Chromium): full suite **52 passed** (rebased on `feature/mvp` 3b97dc7) (incl. `shell.spec.ts`, whose h1 checks cover these pages); the 3 new tests also passed `--repeat-each=4`. Owner: field error → fix → Save → header + DB updated, reload keeps values; areas add (tidied name) / duplicate refused / rename / hide (confirm, moves to end, "Hidden") / show again; audit actions in the DB; no horizontal scroll at 360 px (screenshots checked). Staff: read-only notice, no Save/textboxes, no area buttons. Read-only Owner: "Pay for the app" notice, no buttons.
- Root: `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10, DB suites ran), `pnpm build` (10/10), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T16:18:54.669Z claimed by agent-t030
- 2026-10-13T19:08:04.527Z completed on task/T-030-settings-business-profile-and-areas
