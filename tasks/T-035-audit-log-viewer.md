---
id: T-035
title: Audit log viewer
phase: 1
area: web
status: done
owner: agent-t035
claimed_at: 2026-10-14T06:30:49.438Z
branch: task/T-035-audit-log-viewer
depends_on: [T-029, T-025]
review: self
claimable_by: agent
size: S
paths: [apps/web/src/app/(operator)/settings/audit/**, packages/core/src/audit-query/**, packages/i18n/messages/*/audit.json]
---

# T-035 — Audit log viewer

**Phase** 1 · **Area** web · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-029, T-025

## Goal

Owner can see who changed what.

## Scope

- Filter by date, user, entity type, action; human-readable sentences ('Ramesh (Staff) changed phone of customer 1045').
- Before/after diff view with redacted sensitive fields.

## Acceptance criteria

- [x] Owner-only.
- [x] Paginates 100k events smoothly (keyset pagination).

## Tests required

- Query tests + isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/audit/**`
- `packages/core/src/audit-query/**`
- `packages/i18n/messages/*/audit.json`

## References

FR-024 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/audit-query/list.ts` | `listAuditEvents` (`audit.list`, capability `audit.view`: Owner only, READ ONLY, works in read-only mode). Input `{ from?, to? (IST business dates), actor?: userId \| "system", entityType?, entityId? (needs entityType), action?, cursor?, limit (≤100, default 50) }`. Output `{ events: AuditEventView[], nextCursor, actors }`. A person filter naming another tenant's (or a made-up) user is NOT_FOUND; a bad cursor is VALIDATION (`fields: [{ path: "cursor" }]`). `AUDIT_ORDER` (see decisions). |
| `audit-query/actions.ts` | `AUDIT_ACTIONS` registry: every audit action the code writes (56 today, incl. T-031's `plans.*`, T-085's `subscription(s).*` and T-045's `adjustments.*`) → a detail extractor for its sentence (amount, method, status, field, dates, months, changed fields, counts). `KNOWN_AUDIT_ACTIONS`, `isKnownAuditAction`, `auditDetails`, `AUDIT_ENTITY_TYPES`, `AuditValue`. |
| `audit-query/present.ts` | The viewer's redaction (`auditChanges`, `presentAuditValue`, `maskContactsInText`, `maskEmail`, `AUDIT_VIEW_HIDDEN_KEYS`). |
| `audit-query/labels.ts` | Batched, tenant-scoped names per entity type for one page (customer code, VC number + customer, plan name, the customer of a bill change, receipt no., person, phone model + code, area, collector + day, billing month; the app subscription needs none). |
| `audit-query/cursor.ts` | `encodeAuditCursor` / `decodeAuditCursor` (opaque base64url of `(at with µs, id)`). |
| `apps/web/src/app/(operator)/settings/audit/` | `page.tsx` (404 for Staff via the route's capability; the service refuses non-Owners anyway), `audit-log.tsx` (filters as a GET form, sentence rows, native `<details>` before/after table, keyset pager), `sentences.ts` (pure: `auditSentence`, `whoText`, `auditTime`, `shownValueText`, `fieldLabel`), `filters.ts` (`readAuditQuery`, `auditHref`). |
| `packages/i18n/messages/{en,hi}/audit.json` | New namespace: `sentence.<action>` and `action.<action>` (filter label) for every registered action, entity words, field words, filters, pager. All Hindi flagged in `_review`. Glossary section "Who changed what words". |
| `packages/db/migrations/0015_audit_events_action_idx.sql` | `audit_events_operator_action_idx (operator_id, action, at DESC NULLS LAST, id DESC NULLS LAST)` (schema: `packages/db/src/schema/audit.ts`). |

**How to add an audit action (every later task):** write it as before (`audit.record`, `writeAuditEvent`, `ctx.audit`), then add it to `AUDIT_ACTIONS` and add `sentence.<action>` + `action.<action>` to both `audit.json` files. `audit-query/actions.test.ts` scans packages/core, apps/web and tools for `action: "…"` literals, string arguments of any call named `*audit*` (`auditRunChange(…, "billing.run_started")`), `AUTH_AUDIT_ACTIONS`, template actions (must be listed in its `TEMPLATE_ACTIONS`), and the default action (service name) of every audited service or write service whose file calls `audit.record(` (except services listed with a reason in `NEVER_THE_DEFAULT_ACTION`, e.g. `subscriptions.overview` always skips, `adjustments.create_manual` records `adjustments.create`); it fails on a missing entry, a stale entry, or a missing en/hi sentence. Until then the viewer shows the safe generic sentence ("Ramesh (Staff) made a change: Customer 1045"), so nothing breaks at runtime. In-flight tasks (T-045 adjustments, T-084 import, T-082 exports) will hit this test with their new actions.

**Decisions**

1. **Ordering must say `DESC NULLS LAST`.** The T-021 index is `(operator_id, at DESC NULLS LAST, id DESC NULLS LAST)`; Drizzle's `desc()` emits plain `DESC` (= NULLS FIRST), which the index can't serve, and Postgres then seq-scanned and top-N-sorted the whole tenant (measured: 25–30 ms on 100k, growing with the table). `AUDIT_ORDER` uses the index's exact order; both columns are NOT NULL, so results are identical. Other keyset lists on `.desc()` indexes may have the same trap.
2. **Keyset on `(at, id)` with microseconds.** The cursor carries `to_char(at, …US)`, not a JS `Date` (ms), so events in the same millisecond (or the same transaction's `now()`) are neither skipped nor repeated. The next page is a row comparison `(at, id) < (…)`, an index condition. Known limit: an event whose transaction started before a page was read but committed after it gets an older `at` and won't appear on pages already passed (refresh shows it).
3. **New index for the action filter only.** Measured on 100k: person, kind, one thing and day filters are fine on the existing indexes; a rare action (e.g. `payments.reverse`) was a parallel seq scan of *every tenant's* events (21–36 ms here, linear in the whole table). Migration 0015 adds the action index; it then reads only its 10 rows (0.14 ms).
4. **One thing's history needs the kind** (`entityId` requires `entityType`) so it uses `audit_events_operator_entity_idx`; ids are only unique per table anyway.
5. **Redaction (viewer, on top of the writer's):** hidden = every `isSensitiveAuditKey` key (passwords, hashes, tokens, OTP, cookies, API keys, KYC/Aadhaar/PAN) + `ip`, `user_agent`, `request_id`, `install_id`, `family_id`, `session_id`, `device_fingerprint`, `push_id`, `fcm` + any `[redacted]` value; a hidden field that is on both sides is still listed ("Hidden → Hidden" = a new password was set). Phones: keys naming phone/mobile/whatsapp → `XXXXXX3210` (T-050's `maskPhone`, the receipt-page rule; <8 digits → Hidden); Indian mobile numbers inside any other text (e.g. a lineman's user name, a note) are masked too, but not identifiers the Owner must read (`vc_number`, `customer_code`, `receipt_number`, `*_date`, `*_at`…), dates or bill numbers. Emails → `r•••@example.com`. UUID values and `*_id` fields (e.g. `razorpay_subscription_id`) are dropped (the sentence names the thing). ISO instants show as IST times. Text is cut at 200 chars, at most 30 rows, nested objects flattened one level. IP and user agent are never shown. Raw `before`/`after` never leave core.
6. **FR-004 vs masking:** T-025 kept full old/new phones in the stored event ("the Owner reads them"); per this task's brief the viewer masks them to the last four digits (enough to tell numbers apart). The full values stay in the table. If the Owner must see full numbers here, it's a one-line change in `present.ts` (product owner to confirm).
7. **Who:** the actor's role is the role at the time (stored); the name is read now. Platform support actors show as "Cable Billing support"; jobs/system as "The app". No IP/user agent shown.
8. **Sentences use ICU `select`/`plural`** (web-only namespace); the web always supplies every placeholder (dash / `other` defaults), and a test renders every action in en + hi with and without details.
9. The filter dropdown lists known actions by short label; the URL accepts any well-formed action (old data).

**Deviations / shared files touched**

- `packages/db/src/schema/audit.ts` (T-021, done): one index line + migration 0015 (regenerated after rebasing on 6bbaac6: T-085 took 0012, T-060 0013/0014).
- `packages/core/src/index.ts`: `export * from "./audit-query";` (Biome sorted it next to `./audit`).
- `packages/i18n/src/generate.test.ts` (T-004, done): asserted generated files never contain the substring `_review`; the action key `payments.resolve_review` contains it. Now checks for the `"_review"` key itself.
- `apps/web/e2e/shell.spec.ts`: `/settings/audit` is no longer "Coming soon"; checks its heading instead.
- `packages/i18n/glossary.md`: appended a section.
- `apps/web/e2e/plans.spec.ts` (T-031, done): its seed id was made at describe level (against `_support/unique.ts`), so with `fullyParallel` a second test group re-seeded the same logins; it failed in every full local run (duplicate login on the `users` insert) and passed alone. Now `run = newSeedId()` in `beforeAll`, like the other specs. T-084 (#73) makes the same edit; on its rebase keep either side (they are equivalent).

**Open questions / follow-ups**

- Q (product owner): full or masked phones in "Who changed what" (decision 6).
- Retention of audit events: still Q-06 (keep everything); the indexes keep pages fast regardless.
- A customer's History tab (T-049) can reuse `listAuditEvents({ entityType: "customer", entityId })` if it should show contact changes; the capability is Owner-only today.

**Verification** (Node v24.21.0, pnpm 12.11.2, PostgreSQL 17; rebased on `feature/mvp` 6bbaac6)

- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10: core 1023 passed + 2 skipped opt-in benches of other tasks, web 449, db 254, i18n 42, …), `pnpm build` (10/10), `pnpm generate` (no diff), `tokens:build --check`, `icons:build --check`, `i18n:build --check`, `openapi:build --check`, `db:check`, `node scripts/tasks.mjs check --local`.
- Web e2e (fresh scratch DB `cb_e2e_t035`, `next start`): full suite 84/84 passed (after the plans.spec seed fix). `e2e/audit.spec.ts` 3/3, also with `--repeat-each=2`: Staff 404; Owner sees a real "added area" from the app, the seeded staff phone change (masked `XXXXXX1122` / `XXXXXX2211`) and a new password "Hidden", and neither phone nor the password appears anywhere in the HTML; filters by person, kind + change; pages 50 → 10 and back; a hand-edited cursor starts from the newest; Hindi at 360 px without sideways scrolling.
- Core tests: `list.test.ts` (Owner only — Staff and lineman FORBIDDEN from the service; read-only tenant; real services' events; labels incl. payment/plan/area/missing; every filter with IST day edges 23:59:59.999/00:00; NOT_FOUND / VALIDATION cases; 230 events with shared `at` and µs-apart times paged by 50 while new events are inserted concurrently → exactly the original 230, in order, no duplicates, 5 pages; viewer redaction of an unredacted row), `present.test.ts` (redaction/masking units), `actions.test.ts` (sentence coverage; it found `billing.run_completed` and the `receipts.*` link actions I had missed, and T-085's three actions after the rebase), isolation cases (list no-leak ×3, other tenant's person → NOT_FOUND), coverage test.
- **100k performance** (`performance.test.ts`, 100,035 events in one tenant + 20,000 in another, ANALYZE'd). Postgres time per page (EXPLAIN ANALYZE as `app_rw`, RLS on): first page 0.10 ms (Index Only Scan `audit_events_operator_at_idx`), after 50,000 events 0.09 ms (same index, `ROW(at, id) < ROW(…)` as Index Cond), rare action 0.06 ms (Index Only Scan `audit_events_operator_action_idx`), by person 0.10 ms, one customer 0.11 ms (`audit_events_operator_entity_idx`). Whole service call (transaction, people list, name lookups) best of 3, test file alone: first page 17.6 ms, next 12.9 ms, after 50,000 12.2 ms, filters 2.6–21.4 ms; with the whole monorepo testing in parallel (load average 14–22 on 4 CPUs) 18–316 ms; the test's wall-clock budget is 1.5 s (shared CI), the plan assertions (no Seq Scan, the right index, keyset as Index Cond) are the real guard. Before decision 1 the first page was a seq scan + sort (28 ms in Postgres, 76 ms per call).

## Board log

- 2026-10-14T06:30:49.439Z claimed by agent-t035
- 2026-10-14T07:20:25.959Z completed on task/T-035-audit-log-viewer
