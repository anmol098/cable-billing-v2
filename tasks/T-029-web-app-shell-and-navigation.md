---
id: T-029
title: Web app shell and navigation
phase: 1
area: web
status: done
owner: agent-t029
claimed_at: 2026-10-13T13:58:03.467Z
branch: task/T-029-web-app-shell-and-navigation
depends_on: [T-007, T-026]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/layout.tsx, apps/web/src/app/(operator)/*/page.tsx, apps/web/src/components/shell/**, apps/web/src/lib/nav.ts, packages/i18n/messages/*/shell.json]
---

# T-029 — Web app shell and navigation

**Phase** 1 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-007, T-026

## Goal

The frame every operator page lives in, with ALL nav destinations pre-created so feature tasks never edit shared nav files.

## Scope

- Sidebar (desktop) / bottom bar + More (mobile) with the 7 items from PLAN §12.1, icons + bilingual labels, role-based visibility.
- Placeholder `page.tsx` for every section and sub-route listed in PLAN §12.1 (each shows EmptyState 'Coming soon'); feature tasks replace these files.
- Header: operator name, language switch, account menu, read-only/grace banner slot (reads subscription state).
- Home page skeleton with setup checklist component (data wiring in T-083).

## Acceptance criteria

- [x] Staff do not see Owner-only items (Settings › Subscription/Team/Audit, exports).
- [x] Works at 360px width.

## Tests required

- Component tests for nav visibility per role; Playwright smoke navigating all items.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/layout.tsx`
- `apps/web/src/app/(operator)/*/page.tsx`
- `apps/web/src/components/shell/**`
- `apps/web/src/lib/nav.ts`
- `packages/i18n/messages/*/shell.json`

## References

PLAN §12.1, PLAN §12.2, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `apps/web/src/lib/nav.ts` | The nav config: `NAV` (7 sections, each with `children`; `id`, `path`, `icon`, `capability`), types `NavSectionId`, `NavRouteId`, `NavRoute`, `NavSection`, `NavLink`, `NavCapability`, `CanFn`; helpers `allRoutes`, `findRoute`, `sectionOf`, `canSeeRoute`, `visibleSections`, `visibleChildren`, `toNavLinks`, `isActivePath`, `isDynamicPath`, `splitForBottomBar` (`BOTTOM_BAR_SLOTS` = 4), `WEB_APP_CAPABILITY`. Pure and client-safe (no `@cb/core` import). |
| `apps/web/src/app/(operator)/layout.tsx` | The shell: `await getTenantContext()` (the gate), `loadShellData`, header, banner slot, `SideNav` (from `md`), `BottomNav` (under `md`), `<main id="main">`, skip link, and **`ToastProvider` mounted once** (`common.close`, `ui.notifications`). |
| `apps/web/src/components/shell/` | `access.ts` `roleCan(role)` → `CanFn` (T-025 `can`); `shell-data.ts` `loadShellData(ctx)` (one read-only `withTenant` transaction: business name, user name, subscription status + `grace_ends_at`; `react` `cache`d); `shell-header.tsx` `ShellHeader` (business name, `LocaleSwitch`, `AccountMenu`); `account-menu.tsx` (client; user name, role word, `signOutAction` / `signOutEverywhereAction` forms); `side-nav.tsx`, `bottom-nav.tsx` (client; `aria-current="page"`, More list, closes on Escape / outside tap / page change via `use-dismiss.ts`); `subscription-banner.tsx` `bannerFor(input, canPay)` + `SubscriptionBanner` (the banner slot); `shell-page-header.tsx` `ShellPageHeader`; `layout-classes.ts` (`PAGE_ACTION_ABOVE_NAV`, `SHELL_MAIN_CLASS`, `BOTTOM_BAR_HEIGHT`); `section-menu.tsx` `SectionMenu`; `placeholder-page.tsx` `PlaceholderPage`, `SectionIndexPage`, `placeholderMetadata`; `setup-checklist.tsx` `SetupChecklist` + `setupStepsFor(can, done)`. |
| `packages/i18n/messages/{en,hi}/shell.json` | Namespace `shell`: `routes.<route id>` (every menu/page title), `main_menu`, `more`, `more_menu`, `skip_to_content`, `section_pages`, `coming_soon`, `account.*`, `banner.*`, `checklist.*`. All Hindi in `_review`. Sign-out words reuse `auth.sign_out*` (T-026). Glossary: new "Menu words (web)" table. |
| Icons (`packages/design-tokens/icons.json`, T-003 done) | `more` (ellipsis), `business` (store), `team` (users), `subscription` (credit-card), `undo` (undo-2); regenerated `icons.generated.ts` and Android `ic_cb_*.xml`. |

**Routes (every one has a `page.tsx` today; `nav.test.ts` fails if a route and the pages on disk drift)**

| Section (capability) | Pages (capability; Owner-only in bold) | Owner task |
|---|---|---|
| `/home` (`dashboard.view`) | home skeleton + setup checklist | T-083 |
| `/customers` (`customers.view`) | `/customers/new`, `/customers/import` (`customers.manage`); `/customers/[id]`, `/[id]/connections`, `/[id]/bills`, `/[id]/payments`, `/[id]/history` (`customers.view`) | T-033, T-084, T-034, T-049, T-048 |
| `/payments` (`payments.record`) | `/payments/new`, `/payments/review` (`payments.record`), **`/payments/reversals`** (`payments.reverse`) | T-048 |
| `/linemen` (`handover.review`) | `/linemen/[id]` (one lineman's day / handover review) | T-062 |
| `/bills` (`billing.preview`) | `/bills/runs`, `/bills/register`, `/bills/[id]` (`billing.preview`), **`/bills/adjustments`** (`adjustments.manage`) | T-047, T-045 |
| `/reports` (`reports.view`; the page is the list of reports, kept) | `/reports/dues`, `/bills`, `/payments`, `/collections`, `/handover`, `/connections`, `/billing-runs` (`reports.view`), **`/reports/export`** (`exports.csv`) | T-080, T-081, T-082 |
| `/settings` (`dashboard.view`; the page is the list, kept) | `/settings/profile`, `/areas`, `/plans` (`dashboard.view`: Staff may look, T-030/T-031 make them read-only), **`/settings/team`** (`team.manage`), **`/settings/subscription`** (`subscription.manage`), **`/settings/audit`** (`audit.view`) | T-030, T-031, T-032, T-085, T-035 |

Every section also needs `dashboard.view` (PLAN §9.3 "Web dashboard"), so a lineman sees nothing.

**How feature tasks replace a placeholder**

- Overwrite the route's `page.tsx` (it is a 6-line file calling `<PlaceholderPage route="…">`). Keep the URL. Call `getTenantContext()` in the page/actions as T-026 says, and check the capability in your service (the menu hiding is not the boundary; the placeholder 404s routes the role can't see, your page must keep doing that for Owner-only pages, e.g. `if (!can(ctx.role, "team.manage")) notFound()`).
- Page header: use **`ShellPageHeader`** (= T-007 `PageHeader` with the phone action lifted above the bottom bar) and put `PAGE_ACTION_CLEARANCE` on the page body when there is an action. Toasts: `useToast()` works anywhere under the shell.
- Title: `export const generateMetadata = () => placeholderMetadata("<route id>")` reuses the menu word; or write your own.
- Reaching sub-pages before a section page is built: the section placeholders list their static sub-pages (`SectionMenu`); `/settings` and `/reports` are real menu pages and stay.
- Customer profile tabs: T-033 owns `customers/[id]/page.tsx` and decides the tab bar; the tab routes already exist as placeholders (`connections`, `bills`, `payments`, `history`). No `/customers/[id]/summary` route was created: the summary is `/customers/[id]` (PLAN §12.1 "Profile tabs: Summary …").
- T-083: replace `home/page.tsx`; pass real flags: `setupStepsFor(roleCan(ctx.role), { plans, customers, linemen, app })` and add the Play link/QR to the `app` step (`SetupStep.href`, or extend the component; it renders no button for a step without `href`). The checklist hides itself when every step is done.
- T-085: the banner slot is `SubscriptionBanner` + `bannerFor` (fed by `loadShellData`'s subscription row). Extend there (e.g. trial-ending reminders) rather than adding a second banner.
- A new top-level section needs a `NAV` entry, `shell.routes` words, a page, and `PROTECTED_PREFIXES` + the proxy matcher (T-026; `nav.test.ts` checks every route is protected).

**Decisions**

1. Visibility = capabilities only (`roleCan(role)` → T-025 `can`), section and page each carry one capability. Staff see all 7 sections; Owner-only pages (Undo payment, Bill changes, Download data, Team, Subscription, Audit) are hidden from them and their placeholders answer 404 (`notFound()`, same as cross-tenant ids).
2. "Exports" became one page, `/reports/export` ("Download data", `exports.csv`), so the hidden item is concrete; T-082 owns `reports/_export/**` (private folder) and `api/exports/**` and may build per-report buttons instead, replacing this placeholder.
3. Phone bottom bar shows **3 sections + More** (`BOTTOM_BAR_SLOTS = 4`). With 4 + More the labels "Customers"/"Payments" were cut off at 360px at the smallest type token (screenshot checked). More opens a list just above the bar; More is marked active when the current page is in it.
4. Header on phones: the business name gets its own line (it was cut to "Active C…"), language switch and Account (icon + word) on the second line; one line from `sm`.
5. Banner: `grace` → Owner only (amber, "Pay for the app by {date}" in IST + Pay now → `/settings/subscription`); `read_only` / `cancelled` / no row (fail closed, `tenantModeOf`) → everyone (red "View only. You can still collect money."), Owner gets Pay now, Staff get "Ask the owner…". PLAN §11.9 says only the Owner sees the subscription warning; Staff do see read-only because their buttons stop working (please confirm).
6. Shell data is read directly with `runtime.db.withTenant(ctx.operatorId, …, { accessMode: "read only" })` from apps/web (no service): it has no input ids, RLS scopes it, and adding a core service + isolation case for three columns seemed heavier than it's worth. Move it to a `packages/core` read service if a later task prefers.
7. Settings sub-pages Profile/Areas/Plans are visible to Staff (`dashboard.view`): T-030 says "Staff read-only"; Plans viewing seemed equally needed when adding connections.
8. Route id `payments_check` (not `payments_review`): the i18n generator test forbids `_review` in generated output (it's the Hindi review marker).

**Deviations / files outside the owned glob**

- Sub-route placeholders deeper than `(operator)/*/page.tsx` (e.g. `customers/[id]/bills/page.tsx`, `settings/team/page.tsx`): required by the scope ("every section and sub-route"); each is owned by the feature task listed above.
- `apps/web/e2e/shell.spec.ts` (T-088's e2e folder, as T-026 did). It seeds its own tenants like `auth.spec.ts` (there is no shared fixture module to reuse).
- `packages/design-tokens/icons.json` + generated icons (5 new names), `packages/i18n/glossary.md` (menu words), generated `apps/web/messages/*.json`, removed `(operator)/.gitkeep`.
- `PROTECTED_PREFIXES` / proxy matcher: **no change needed**, T-026 already lists all 7 sections; a test now checks it against `NAV`.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 2c2140a)

- `pnpm --filter web test`: 13 files / 112 tests. New `components/shell/nav.test.ts` (14): 7 sections in order, unique ids/paths, real capabilities, en+hi word per route, **one `page.tsx` per route on disk**, every route behind `PROTECTED_PREFIXES`; per-role matrix (hand-written expected pages for Owner and Staff), Staff `canSeeRoute` false for the 6 Owner-only pages and true for the rest, lineman sees nothing; bottom-bar split; active path; checklist steps per role; banner matrix. `components/shell/shell.test.tsx` (19): SideNav for Owner/Staff (icon + word, `aria-current` on sub-pages), BottomNav (3 + More, opens/Escape returns focus/outside tap/page change, More active), Settings menu Owner vs **Staff (no Team/Subscription/Audit)**, Reports menu Staff without "Download data", ShellHeader EN/HI + account menu, banner (grace date in IST, read-only for Staff, Hindi, none when active), SetupChecklist, ShellPageHeader lifts the pinned action (`bottom-16`).
- `pnpm --filter web test:e2e` (scratch DB `cb_e2e_t029` migrated, `E2E_PORT=3229`, pre-installed Chromium): 20 passed, 5 new in `shell.spec.ts`: Owner at 1280px clicks all 7 sidebar items (h1 + `aria-current`) and opens **every route** (200 + title, dynamic ones with a made-up id); **360px**: bar shows 3 + More, every section reached through the bar/More, **no horizontal scroll** on every static page, bar flush with the bottom, Hindi via the header switch still fits; Staff: Settings lists only Business details/Areas/Plans, no Download data / Undo payment links, the 6 Owner-only URLs return **404**; grace Owner sees "Pay for the app by 25 Oct 2026." + Pay now → `/settings/subscription` at 360px, read-only Staff sees the view-only banner without a link; account menu → Sign out → `/login?notice=signed_out`, `/home` then redirects to login.
- Screenshots (360px EN/HI, 1280px Owner/Staff, More open, account menu, grace banner) checked by eye.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9, DB suites against a local DB), `pnpm build` (9/9, no env set: `next build` succeeds), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T13:58:03.468Z claimed by agent-t029
- 2026-10-13T14:24:57.731Z completed on task/T-029-web-app-shell-and-navigation
