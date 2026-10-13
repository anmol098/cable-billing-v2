---
id: T-021
title: Schema: tenancy, identity, devices, audit, counters
phase: 1
area: db
status: done
owner: agent-t021
claimed_at: 2026-10-13T11:55:23.489Z
branch: task/T-021-schema-tenancy-identity-devices-audit-co
depends_on: [T-020]
review: required
claimable_by: agent
size: M
paths: [packages/db/src/schema/tenancy.ts, packages/db/src/schema/auth.ts, packages/db/src/schema/audit.ts, packages/db/src/schema/counters.ts, packages/db/src/schema/subscriptions.ts, packages/db/src/schema/index.ts, packages/db/migrations/**]
---

# T-021 — Schema: tenancy, identity, devices, audit, counters

**Phase** 1 · **Area** db · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-020

## Goal

Tables for tenants, users and the cross-cutting audit/counter infrastructure.

## Scope

- `operators` (duplicate names allowed; `settings` jsonb with typed Zod schema: mid_month_start_policy, invoice_prefix, receipt_footer, office_phone, default_language).
- Better Auth tables (user/session/account/verification) adapted: users have `operator_id` (nullable for platform admin), `role` enum owner|staff|lineman|platform_admin, globally unique lower-cased `login`, `language`, `status`.
- `devices` (install_id, device_code 3 chars unique per operator, revoked_at), mobile refresh tokens (hashed).
- `areas`, `counters` (+ `next_counter(operator, name)` SQL function using UPDATE…RETURNING), `audit_events`, `subscriptions` (state columns only; logic in T-085).
- RLS on all tenant tables; composite FKs.

## Acceptance criteria

- [x] Two operators with identical names coexist (FR-002 test).
- [x] Counter function is gap-free and safe under 50 concurrent calls.

## Tests required

- Constraint + concurrency integration tests.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/db/src/schema/tenancy.ts`
- `packages/db/src/schema/auth.ts`
- `packages/db/src/schema/audit.ts`
- `packages/db/src/schema/counters.ts`
- `packages/db/src/schema/subscriptions.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/migrations/**`

## References

PLAN §7.2 (operators, users, devices, areas, counters, audit_events, subscriptions), FR-002, FR-024, FR-025, D-15, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

All tables are in `public`, RLS-enabled, and covered by T-020's security-audit test. Policy summary (who may touch what on the platform path) is in `packages/db/README.md` → "What withPlatform may do".

**Tables** (`src/schema/*.ts`; Drizzle exports in parentheses)

| Module | Table | Key points |
|---|---|---|
| tenancy | `operators` (`operators`) | id = tenant id, `name` not unique (FR-002), `phone`, `address`, `settings` jsonb, `status` `operator_status` (`active\|suspended`), timestamps, `legacy_source/id`. RLS: `app_rw` SELECT/INSERT/UPDATE only `id = app.current_operator()` (no DELETE); `app_platform` SELECT. Triggers: id immutable, no DELETE/TRUNCATE for any role (CB001). |
| tenancy | `areas` (`areas`) | tenant table, `tenantKey`, UNIQUE `(operator_id, lower(name))`, `archived_at` (T-030 archives instead of deleting), legacy cols. |
| auth | `users` (`users`) | `operator_id` NULL **iff** `role = 'platform_admin'` (CHECK); `role` `user_role` (`owner\|staff\|lineman\|platform_admin`); `login` NOT NULL, globally UNIQUE, CHECK lower-case / no whitespace / 3–100 chars; `display_login`; `email` UNIQUE + lower-case CHECK, required for platform admins; `email_verified`, `image`, `phone`, `language` (`language` enum `hi\|en`, no default: set it explicitly), `status` `user_status` (`active\|disabled`), `two_factor_enabled`, timestamps, legacy cols; `tenantKey`. Trigger: `id`/`operator_id` never change (no moving users between tenants). RLS: tenant policy + `app_platform` SELECT/INSERT/UPDATE (no DELETE). |
| auth | `sessions`, `accounts`, `verifications`, `two_factors` | Better Auth `session`/`account`/`verification`/`twoFactor`, column-for-field. `sessions`/`accounts`: `app_rw` ALL where the row's user belongs to the current tenant (EXISTS on `users`), `app_platform` ALL. `verifications`/`two_factors`: `app_platform` only. UNIQUE `sessions.token`, UNIQUE `accounts(provider_id, account_id)`. |
| auth | `devices` (`devices`) | `install_id uuid` UNIQUE per operator; `device_code` CHECK `^[A-Z0-9]{3}$`, UNIQUE per operator **including revoked devices** (provisional refs never become ambiguous); `user_id` (last signed-in user), `model`, `os_version`, `app_version`, `app_version_code`, `last_seen_at`, `revoked_at`, `revoked_by`; composite FKs to `users(operator_id, id)`. |
| auth | `mobile_refresh_tokens` (`mobileRefreshTokens`) | `token_hash` CHECK `^[0-9a-f]{64}$` (hex SHA-256; a raw token can't be stored) and globally UNIQUE; `family_id`, `parent_id` (self composite FK), `expires_at`, `rotated_at`, `revoked_at` + `revoked_reason` (`refresh_token_revoke_reason`: `logout\|reuse_detected\|device_revoked\|user_disabled\|password_changed`, both-or-neither CHECK); composite FKs to users and devices. `app_platform` SELECT only. |
| audit | `audit_events` (`auditEvents`) | `operator_id` NULL = platform event; `actor_id` (FK users) + `actor_role` (both or neither; NULL = system); `action` dotted snake_case CHECK, `entity_type` snake_case CHECK, `entity_id uuid`, `before`/`after` jsonb, `ip inet`, `user_agent`, `request_id`, `at`. Indexes `(operator_id, at desc, id desc)` (keyset), `(operator_id, entity_type, entity_id, at)`, `(operator_id, actor_id, at)`. Append-only for every role. `app_platform` SELECT/INSERT only rows with `operator_id IS NULL`. |
| counters | `counters` (`counters`) | PK `(operator_id, name)`, `name` `counter_name` (`invoice\|receipt\|customer_code`), `next_value bigint` ≥ 1. Triggers: only `next_value` may change, never downwards; no DELETE/TRUNCATE. |
| subscriptions | `subscriptions` (`subscriptions`) | PK `operator_id`; `status` `subscription_status` (`trialing\|active\|grace\|read_only\|cancelled`, default trialing); `trial_ends_at` (required when trialing), `current_period_end`, `grace_ends_at` (required in grace), `razorpay_customer_id`, `razorpay_subscription_id` (UNIQUE), `plan_code`, `cancelled_at`, timestamps. `app_platform` SELECT/UPDATE (no INSERT/DELETE). |
| subscriptions | `subscription_events` (`subscriptionEvents`) | `razorpay_event_id` UNIQUE (use `onConflictDoNothing`), `type`, `payload`, `received_at`, `processed_at`, `processing_error`; nullable `operator_id`. Append-only except `processed_at`/`processing_error`. `app_platform` SELECT/INSERT/UPDATE. |

**Functions / helpers**

- `app.next_counter(operator_id uuid, name counter_name) → bigint` (migration 0002): `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so the first call creates the row and returns 1. SECURITY INVOKER (RLS applies; another tenant's id → 42501), EXECUTE granted to `app_rw` only. TS: `nextCounter(tx, operatorId, "invoice")` from `@cb/db`. Call it inside the transaction that uses the number and keep that transaction short (callers queue on the row lock). Under REPEATABLE READ/SERIALIZABLE, concurrent callers get serialization failures (retry); READ COMMITTED (the default) just waits.
- `operatorSettingsSchema` (Zod), `parseOperatorSettings(json)`, `DEFAULT_OPERATOR_SETTINGS`, types `OperatorSettings`/`OperatorSettingsInput`. Keys: `mid_month_start_policy` (values from `@cb/domain` `MID_MONTH_START_POLICIES`, default `start_next_month`), `invoice_prefix` (`^[A-Z0-9]{1,8}$`, default `INV`), `receipt_footer` (≤ 500 or null), `office_phone` (`^\+?[0-9]{6,19}$` or null; matches the mobile contract's `OperatorInfo`), `default_language` (`hi`). The DB CHECK validates the object type and the two enum keys.
- Enum value arrays + types: `LANGUAGES`, `OPERATOR_STATUSES`, `USER_ROLES`, `USER_STATUSES`, `REFRESH_TOKEN_REVOKE_REASONS`, `COUNTER_NAMES`, `SUBSCRIPTION_STATUSES`.
- `authSchema` = `{ user, session, account, verification, twoFactor }` for Better Auth's Drizzle adapter.
- Test harness (`@cb/db/testing`): `createTenant` now inserts the `operators` row (T-020's ask; signature unchanged, now takes anything with `admin`); new `createUser(t.current, { operatorId, role?, login?, name?, language? })`.

**How later tasks use this**

- **T-022/T-023:** reference `operators.id` via `operatorIdColumn().references(() => operators.id)` (or rely on composite FKs), `areas(operator_id, id)` for `customers.area_id`, `users(operator_id, id)` for `created_by`/`collector_id`/`actor_id`, `devices(operator_id, id)` for `payments.device_id`. Numbers: `nextCounter`. Tests: `createTenant` + `createUser`.
- **T-025:** `TenantContext.role` is `UserRole`; `assertWritable` reads `subscriptions.status` (`read_only`/`cancelled` → read-only). Audit writes go to `auditEvents` inside the service's `withTenant` (platform events via `withPlatform` with `operatorId: null`).
- **T-026 (Better Auth):** `drizzleAdapter(db, { provider: "pg", schema: authSchema })`; `username({ schema: { user: { fields: { username: "login", displayUsername: "displayLogin" } } } })`; `twoFactor()`; `user.additionalFields` for `operatorId`, `role`, `language` (required), `phone`, `status`, `legacySource`, `legacyId`, all `input: false` (set server-side, e.g. database hooks); `advanced.database.generateId: () => uuidv7()` (ids are `uuid`). Better Auth runs on the platform path (no tenant yet): build the adapter over the `tx` of a `withPlatform` call (createDb exposes no raw handle). `src/schema/auth.test.ts` does exactly this (sign up with username, sign in by username and by email, platform admin) with better-auth 1.7.7 and its schema check. Lineman-vs-web and disabled-user checks are app logic.
- **T-027:** provision inside `withTenant(newOperatorId)`: insert `operators` (the RLS INSERT policy allows exactly that id), owner `users` + `accounts`, `subscriptions` (`trialing`, `trial_ends_at` +30 d). Counter rows are created lazily by `next_counter`. Idempotency: use the operator id / owner login uniqueness.
- **T-028:** devices upsert on `(operator_id, install_id)`; pick a free `device_code` per operator (retry on 23505). Refresh: hash the token, `withPlatform` SELECT by `token_hash` to learn tenant/device/family, then rotate/revoke in `withTenant`; reuse (a `rotated_at` token presented again) → revoke the family with `reuse_detected`.
- **T-032:** under `withTenant`: create lineman `users` + credential `accounts`, reset password (`accounts.password`), disable (`users.status`), sign out a phone (`devices.revoked_at/by` + revoke its tokens with `device_revoked`), delete a staff member's `sessions`.
- **T-035:** keyset on `(operator_id, at desc, id desc)`. **T-085:** webhook → `subscription_events` `onConflictDoNothing`, state changes on `subscriptions` (platform or tenant path). **T-086:** platform SELECT on operators/users/subscriptions; it needs an extra reviewed policy if the admin must UPDATE `operators.status`.

**Decisions (reviewer please check)**

1. **Auth runs on `app_platform`.** Login/session lookup happens before a tenant is known, so the Better Auth tables are readable/writable by the platform role (users: no DELETE). Alternative considered: a dedicated `app_auth` role (smaller blast radius: platform jobs could not read password hashes); it would need changes to T-020's client and the security audit, so it is left as a proposal.
2. **Better Auth session tokens are stored as Better Auth stores them** (it does not hash `sessions.token`); mobile refresh tokens, which we control, are hash-only by CHECK.
3. **Provisioning inside `withTenant(newId)`** instead of giving `app_platform` INSERT on tenant tables: the tenant may INSERT only its own `operators` row.
4. **Immutability beyond the financial tables:** operators can't be deleted and their id can't change; a user's id/tenant can't change; counters can't be deleted or lowered; audit events and webhook payloads are append-only (all via `app.forbid_update_delete`, CB001). Note: adding a column to `subscription_events` that must be updatable requires recreating its trigger with the new allowed list.
5. **`subscription_events` has `operator_id`**, so (per the audit rule) tenants have the standard policy and can read their own events; the append-only trigger stops them editing payloads.
6. **`users.email` is nullable** (linemen have none) but required for platform admins; `login` is required for everyone (owners/staff need one too: T-027 must pick it, e.g. the mobile number).
7. Defaults chosen: `mid_month_start_policy = start_next_month`, `default_language = hi`, `invoice_prefix = INV`, `users.language` has **no** default.
8. `device_code` stays unique per operator forever (revoked devices keep theirs); `(operator_id, install_id)` is unconditionally unique, so a re-registered phone un-revokes its row (history goes to `audit_events`).

**Deviations / shared files**

- Tests are `src/schema/<module>.test.ts` next to the owned modules.
- `packages/db/package.json` (T-020's, done): deps `zod` (catalog) and `@cb/domain` (workspace, for `MID_MONTH_START_POLICIES`); devDep `better-auth` 1.7.7 for the compatibility test only.
- `src/testing/fixtures.ts` + `src/testing/index.ts` (T-020's, done, as T-020 asked): `createTenant` inserts the operator; new `createUser`.
- `packages/db/README.md`: createTenant/createUser docs and the platform-policy table.
- Added `subscription_events` (not in the Scope list, but in PLAN §7.2 and needed by T-085, and no other task owns a file for it).
- `subscriptions` and `counters` have no `id`, so no `tenantKey` (nothing references them by id).

**Open questions**

- Should owners/staff get 2FA too (the schema supports it for anyone)?
- Data retention for `sessions`/`verifications`/expired refresh tokens (Q-06): a cleanup job is not built.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17)

- `pnpm --filter @cb/db test`: 12 files, 91 tests, all DB suites ran (no skips). New: tenancy (10), auth (12, incl. Better Auth sign-up/sign-in), audit (4), counters (7), subscriptions (6); T-020's security audit passes with all new tables.
- Counter acceptance: 50 concurrent `withTenant` transactions over a 20-connection pool, each holding the row lock 5 ms → exactly 1..50; 50 concurrent with every 5th rolling back after taking a number → committed values exactly 1..40, next_value 41. **Mutation check:** replacing the function with a read-then-update version makes both tests fail.
- FR-002: two `ANMOL CABLE NETWORK` tenants, each with its own owner and area, each seeing only its own operator/users/areas.
- `db:generate` → "No schema changes" after the final regeneration; `db:check` OK.
- Root: `pnpm install`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (all packages; one `@cb/ui` overlay test timed out once under machine load and passed on re-run, unrelated), `pnpm build` (9/9), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T11:55:23.489Z claimed by agent-t021
- 2026-10-13T12:15:58.674Z completed on task/T-021-schema-tenancy-identity-devices-audit-co
