---
id: T-025
title: Core foundations: tenant context, authorization, read-only guard, audit, logging
phase: 1
area: core
status: done
owner: agent-t025
claimed_at: 2026-10-13T12:24:56.652Z
branch: task/T-025-core-foundations-tenant-context-authoriz
depends_on: [T-021, T-024]
review: required
claimable_by: agent
size: L
paths: [packages/core/src/context/**, packages/core/src/authz/**, packages/core/src/audit/**, packages/core/src/errors/**, packages/core/src/logging/**, packages/core/src/testing/**, packages/core/src/index.ts]
---

# T-025 — Core foundations: tenant context, authorization, read-only guard, audit, logging

**Phase** 1 · **Area** core · **Size** L · **Review** required · **Claimable by** agent · **Depends on** T-021, T-024

## Goal

The guard rails every service runs inside.

## Scope

- `TenantContext { operatorId, userId, role, deviceId?, requestId }` built only from server session/token.
- `can(role, capability)` from the fixed matrix in PLAN §9.3; `assertRole`.
- `assertWritable(ctx, capability)` using subscription state with the read-only allowlist (D-13).
- Service wrapper `defineService({ capability, input: zod, run })` → validates input, checks role + writable, runs inside `withTenant`, writes audit event for sensitive capabilities, maps errors.
- Error codes (NOT_FOUND for cross-tenant, FORBIDDEN, VALIDATION, TENANT_READ_ONLY, CONFLICT …).
- Structured JSON logger (request_id, operator_id, no PII).
- **Tenant isolation harness**: helper that, for each registered service, seeds two tenants and asserts cross-tenant ids yield NOT_FOUND and no writes; plus a coverage test failing if any exported service is not registered with the harness.

## Acceptance criteria

- [x] Role matrix is data-driven and unit-tested row by row.
- [x] Coverage test fails when a new service is added without isolation cases.

## Tests required

- Unit tests for authz and writable allowlist; integration test of the harness on a sample service.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/context/**`
- `packages/core/src/authz/**`
- `packages/core/src/audit/**`
- `packages/core/src/errors/**`
- `packages/core/src/logging/**`
- `packages/core/src/testing/**`
- `packages/core/src/index.ts`

## References

PLAN §9.1, PLAN §9.3, PLAN §9.4, FR-001, FR-024, D-13, D-16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`packages/core/src/**`; everything below is exported from `@cb/core`, test helpers from `@cb/core/testing`)

| Module | What |
|---|---|
| `context/tenant-context.ts` | `TenantContext { operatorId, userId, role, channel: "web"\|"mobile", deviceId?, requestId, client?: { ip?, userAgent? } }` (branded, frozen). `resolveTenantContext(runtime, { userId, channel, deviceId?, requestId, client? })` → `Result<TenantContext, UNAUTHENTICATED\|FORBIDDEN\|ACCOUNT_DISABLED>` (`details.reason`: `unknown_user`, `user_disabled`, `operator_suspended`, `not_a_tenant_user`, `channel_not_allowed`, `device_missing`, `device_revoked`). `isIssuedTenantContext`. |
| `context/runtime.ts` | `createServiceRuntime({ db, logger?, now? })` → `ServiceRuntime { db, logger, now }`; `newRequestId()` (UUIDv7), `requestIdFrom(header)`, `isRequestId`. |
| `context/service.ts` | `defineService({ name, capability, input: zod, isolationLevel?, run })` → `Service` with `.call(runtime, ctx, input)` → `Result<T, ServiceError>`. `isService`, types `AnyService`, `ServiceArgs`, `ServiceInput`. |
| `context/runtime-role.ts` | (coordinator ask, T-020a) `startRuntimeRoleCheck(runtime, { onUnsafe?, env? })`, `logRuntimeRoleCheck`, `shouldCheckRuntimeRole(env)`. |
| `authz/capabilities.ts` | `CAPABILITIES` (the §9.3 matrix as data: roles, `kind` read/write, `audited`, source row), `can(role, capability)`, `TENANT_ROLES`, `rolesFor`, `isCapability`, `capabilitySpec`. `authz/assert-role.ts`: `assertRole(ctx, capability)`. |
| `authz/writable.ts` | `assertWritable(tx, capability)`, `readTenantMode(tx)` → `"normal"\|"read_only"` (for `GET /app/config` `tenant_mode` and web banners), `tenantModeOf(status)`, `isAllowedInMode`, `READ_ONLY_ALLOWLIST`, `READ_ONLY_STATUSES`. |
| `audit/` | `AuditRecorder` (`record(event)`, `skip(reason)`), `writeAuditEvent(tx, row)` for writers outside services (platform events: `withPlatform` + `operatorId: null`), `redactForAudit`, `isSensitiveAuditKey`, `REDACTED`. |
| `errors/errors.ts` | `CORE_ERROR_CODES` = `BASE_ERROR_CODES` + `ACCOUNT_DISABLED` + `INTERNAL` (all in `@cb/contracts` `ERROR_CODES`, tested, so `httpStatusForError` maps every one), `ServiceError`, `serviceError`, `notFound()`, `validationError(zodError)`, `toServiceError(e)`, `isExpectedError`. |
| `logging/` | `createLogger({ sink?, fields?, strict?, level? })` → `Logger { debug, info, warn, error, child }`, `jsonLineSink` (JSON lines, stdout/stderr), `errorLogFields(e)`, `PiiInLogError`, `silentLogger`; `findPii`, `isPiiKey`, `piiKindOfValue`, `scrubText`. |
| `testing/` (`@cb/core/testing`) | `seedTenant(t.current, { subscription? })` → `{ operatorId, users: { owner, staff, lineman }, deviceId }`, `setSubscriptionStatus`, `contextFor(runtime, tenant, role)` (real `resolveTenantContext`), `testRuntime(db, { now? })` (strict captured logger, `.records`), `captureLogs`, `unverifiedTestContext` (pure unit tests only); isolation harness `defineIsolationCases`, `exemptFromIsolation`, `checkIsolationCase`; `databaseFingerprint`/`changedTables`; discovery + `findCoverageGaps`. |

**How to write a service (T-026 … T-086)**

```ts
// packages/core/src/areas/areas.ts
export const renameArea = defineService({
  name: "areas.rename",                       // dotted snake_case, unique; default audit action
  capability: "business_profile.manage",      // exactly one, from CAPABILITIES
  input: z.object({ areaId: z.uuid(), name: z.string().trim().min(1).max(60) }),
  async run({ ctx, input, tx, audit, log, now }) {
    const [before] = await tx.select().from(areas).where(eq(areas.id, input.areaId)).for("update");
    if (!before) return err(notFound());       // missing and other-tenant ids look the same
    const [after] = await tx.update(areas).set({ name: input.name }).where(eq(areas.id, input.areaId)).returning();
    await audit.record({ entityType: "area", entityId: after.id, before: { name: before.name }, after: { name: after.name } });
    return ok({ id: after.id, name: after.name });
  },
});
// adapter (server action / route): const r = await renameArea.call(runtime, ctx, formInput);
```

- `call` does, in order: refuse a context not issued by `resolveTenantContext` (throws) → **role** (FORBIDDEN, checked before the input so an unauthorised caller learns nothing about it) → **validate** (VALIDATION with `details.fields: [{ path, code }]`, never values) → `db.withTenant(ctx.operatorId)` (read capabilities that aren't audited run `READ ONLY`) → **writable** inside the same transaction (TENANT_READ_ONLY) → `run` → **audit check** → commit → one log line.
- **An `err` result rolls the transaction back.** Anything `run` wrote before failing is gone. Return `ok` with an outcome field when a partial result must commit (e.g. per-item batch outcomes).
- Never take `operator_id`, `role`, `user_id` or `device_id` from `input`; use `ctx`. Use `now` (runtime clock), not `new Date()`, for business dates.
- Thrown errors are mapped: RLS `42501` and FK `23503 … is not present` → NOT_FOUND (no details); FK still referenced, unique/exclusion, `CB001` (append-only), `40001`/`40P01` (`details.retryable`) → CONFLICT (`details.constraint` for unique/FK: map it to a friendly field error, e.g. duplicate customer code); check/not-null/`22P02` → VALIDATION; anything else → INTERNAL (logged with `error_type`, `sqlstate`, `constraint_name`, scrubbed message).
- Service-specific codes: `ServiceError<"NOTHING_TO_BILL">` etc. work (`C` generic); the adapter maps unknown codes by HTTP status.
- **Audit:** capabilities with `audited: true` must call `audit.record(...)` at least once on success (same transaction; actor, tenant, request id, IP, user agent come from `ctx`), or `audit.skip("idempotent_replay" | "no_change")`; otherwise the call fails with INTERNAL and rolls back. `before`/`after` are redacted (passwords, hashes, tokens, OTP, cookies, API keys, KYC/Aadhaar/PAN); business values such as an old/new phone stay (the Owner reads them, FR-004).
- **Logging:** use the `log` from `run` (already has `request_id`, `operator_id`, `user_id`, `role`, `channel`, `service`, `capability`). Event names are dotted snake_case; fields are ids/codes/counts/amounts/durations. Names, phones, emails, logins, addresses, tokens, IPs, user agents, UPI refs and notes are refused by key and by value: under Vitest the logger throws `PiiInLogError` (and `call` rethrows it, so the test fails); in production the field is replaced by `[redacted]` and listed in `pii_redacted`.

**Building the context (T-026, T-028)**

- Web: `resolveTenantContext(runtime, { userId: session.user.id, channel: "web", requestId: requestIdFrom(headers.get("x-vercel-id")), client: { ip, userAgent } })`. Mobile (`withMobileAuth`): `channel: "mobile"`, `deviceId` from the verified access token. Map errors: UNAUTHENTICATED → 401 (`device_revoked` → `DEVICE_REVOKED` on mobile), ACCOUNT_DISABLED → 403, FORBIDDEN `channel_not_allowed` → `ROLE_NOT_ALLOWED` on mobile. Only pass a platform-set request-id header (never a client-chosen one).
- `operatorId`/`role` come from `users` + `operators` (read with `withPlatform`), the device from `devices` (non-revoked, same tenant, `withTenant`). Role changes and deactivation apply on the next request.

**Registering isolation cases (every service task)**

- Next to the service, `<feature>.isolation.ts` exporting `defineIsolationCases(service, { seed, cases })`. `seed({ tx, tenant })` runs in `withTenant(tenant.operatorId)` and returns the ids the cases need. Each case: `{ name, input: (seed, tenant) => input, expect?: "not_found" | "no_leak", roles?, control?: "ok" | "not_not_found" }`. Example: `src/testing/samples/sample-services.ts`.
- `not_found` (default): the harness seeds attacker A and victim B, calls as A (every allowed role) with B's ids and requires NOT_FOUND, no B id in the error and a byte-identical database; then calls with A's own ids and requires `ok` (the control proves the case exercises the lookup). `no_leak` (lists/search/reports): calls as B first (warms caches), then as A; A's output must contain none of B's ids and at least one of A's, and B's rows must not change.
- `src/testing/isolation.test.ts` discovers and runs every `*.isolation.ts`; `src/testing/coverage.test.ts` fails when an exported service has no case set, when a service whose input contains a UUID has no `not_found` case, on duplicate service names, orphan case sets, and exemptions (`exemptFromIsolation(service, reason)`) without a real reason. Don't edit those two files.
- Core modules must have **no import-time side effects** (discovery imports every module under `src/` except tests and `testing/`).
- `packages/core/src/index.ts`: append one `export * from "./<feature>";` line per feature module.

**Capabilities (PLAN §9.3; owner/staff/lineman; R = read, A = audited)**

`dashboard.view` O S (R) · `customers.view` O S L (R) · `customers.manage` O S (A) · `customers.phone.update` O S L (A) · `connections.status.change` O S (A) · `plans.manage` O (A) · `payments.record` O S L (A) · `receipts.share` O S L · `payments.reverse` O (A) · `adjustments.manage` O (A) · `billing.preview` O S (R) · `billing.run` O (A) · `handover.submit` L (A) · `handover.review` O S (A) · `reports.view` O S (R) · `reports.own_day.view` O S L (R; the service must restrict a lineman to their own day) · `exports.csv` O (R, A) · `team.manage` O (A) · `subscription.manage` O (A) · `business_profile.manage` O (A; profile, receipt footer, invoice prefix, mid-month policy, areas) · `audit.view` O (R). The platform admin has none (PRD §3).

**Read-only mode (D-13):** tenant is read-only when `subscriptions.status` is `read_only` or `cancelled`, **or there is no subscription row (fail closed)**. Allowed then: every read capability, plus `payments.record`, `receipts.share`, `handover.submit`, `subscription.manage`. Everything else → TENANT_READ_ONLY (incl. `customers.phone.update`, `billing.run`, `handover.review`). Consistent with T-051's `TENANT_READ_ONLY` meaning.

**Runtime role check (T-020a, coordinator request):** apps/web calls `startRuntimeRoleCheck(runtime, { onUnsafe: (r) => Sentry.captureMessage(...) })` once next to its runtime singleton. It runs only when `VERCEL_ENV=production` or `VERCEL_TARGET_ENV=staging`, once per process, in the background, and logs `db.runtime_role_unsafe` (error, with issue codes/messages), `db.runtime_role_warning`, `db.runtime_role_ok` or `db.runtime_role_check_failed`; it never throws. Wiring into apps/web is not done here (outside this task's paths).

**Security decisions (reviewer please check)**

1. Context is unforgeable by type (brand keyed by a module-private `unique symbol`) and at runtime (issued contexts are frozen and kept in a WeakSet; `call` throws for anything else, so `as TenantContext` casts don't pass). The WeakSet is keyed through `Symbol.for` on `globalThis` so duplicate bundles of `@cb/core` accept each other's contexts.
2. Role/channel binding enforced in the builder: lineman only on `mobile` (with a valid device), owner/staff only on `web` (D-16; T-026/T-028 acceptance criteria). Platform admins get FORBIDDEN (no tenant).
3. Role is checked before input validation (deviation from the "validate → role" order in the brief): a caller without the capability gets FORBIDDEN without learning anything about the input shape.
4. Writable check runs inside the service transaction, so the check and the write see the same subscription row. No row → read-only (fail closed).
5. `err` results roll back; audited capabilities can't commit without an audit row in the same transaction; read capabilities run READ ONLY (a write attempt fails as INTERNAL).
6. Cross-tenant → NOT_FOUND with no details, including the DB-level errors that only a cross-tenant reference can cause (42501, FK not present). The harness checks the error mentions none of the victim's ids.
7. Logs: no PII by key or value; DB error messages (which quote row values) are never logged, other messages are scrubbed; numbers are never inspected (paise vs phone numbers).

**Deviations / shared files**

- `assertWritable(tx, capability)` instead of `(ctx, capability)`: the tenant comes from the `withTenant` transaction (RLS on `subscriptions`), so `ctx` would be unused.
- `defineService` lives in `context/service.ts` (no `service/` folder in the owned paths).
- Shared files: `packages/core/package.json` (deps `@cb/db`, `@cb/domain`, `drizzle-orm` 0.45.4 — same pin as `@cb/db`, `zod` catalog; devDep `@cb/contracts` for the error-code compatibility test; `exports["./testing"]`), `packages/core/turbo.json` (`test.env`: `DATABASE_URL`, `CB_SKIP_DB_TESTS`, `CB_TEST_DATABASE_ALLOW_REMOTE`), `packages/core/vitest.config.ts` (test 30 s / hook 120 s timeouts, like `@cb/db`), `pnpm-lock.yaml`.
- Logger default sink uses `process.stdout/stderr.write` (Biome's `noConsole` allows only warn/error).

**Open questions / possible conflicts (for the product owner)**

- **Lineman phone update vs §9.3.** §9.3 says lineman "view only" for contact edits, but FR-004, PLAN §10.2 (`PATCH /customers/{id}/phone`) and §11.7 have the lineman correct the phone in the receipt flow. Implemented as a separate capability `customers.phone.update` (O S L).
- **Counter payments in read-only mode.** §9.4 lists "Android payment sync"; D-13 says "collections are still allowed". `payments.record` is allowed in read-only mode on both channels (blocking a payment already received seems worse). If web counter payments must be blocked, `assertWritable` can additionally require `ctx.channel === "mobile"` for it.
- **Handover accept/return in read-only mode** is blocked (not on §9.4's list); the lineman's submit is allowed.
- **`handover.submit` is lineman-only** (PLAN §8.7). If staff collecting at the counter also hand over cash (T-062), add staff.
- **System actor for jobs** (T-043/T-044 cron billing runs, subscription-state job): there is no system/job TenantContext yet; `TenantContext` always has a user. Proposal: a `resolveSystemContext(runtime, { operatorId, job, requestId })` in `context/` with a separate capability list, added by a follow-up task when T-043/T-044 need it.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` f4bde6d incl. T-020a and T-022)

- `pnpm --filter @cb/core test`: 12 files, 277 tests, DB suites ran (no skips). Matrix: one test per §9.3 cell (63) from a hand-written table, plus platform admin × every capability, kind/audit flags, and a check that the table and the code list the same capabilities. Read-only: every capability × mode against a hand-written allowlist; `assertWritable` against real subscription rows of two tenants. Context builder: role/operator from the row, disabled user, suspended operator, platform admin, wrong channel, missing/revoked/other-tenant device, malformed request id, `@ts-expect-error` on a literal + runtime refusal of a cast. Service pipeline: audit in the same transaction, forged context, FORBIDDEN before VALIDATION, read-only tenant, rollback on `err`, missing audit, READ ONLY reads, input-supplied operator_id → NOT_FOUND with nothing written, unique → CONFLICT, RLS-limited reads, INTERNAL logging, PII log → test failure. Logger: 24 PII shapes refused (strict) and redacted (production), allowed fields pass. Harness on sample services: 4 correct services pass; FORBIDDEN-instead-of-NOT_FOUND, write-and-succeed, caller-chosen-id upsert (CONFLICT leaks existence), cross-tenant cache, wrong roles and a vacuous control are each reported. Coverage: a fixture tree with one uncovered service is reported exactly.
- Mutation checks (reverted): adding a service under `src/` without cases → coverage test fails with the "add defineIsolationCases" message; adding cases for a service that ignores the tenant → isolation suite fails (`expected NOT_FOUND … got ok` for owner and staff); committing instead of rolling back on `err` → 2 tests fail.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9), `pnpm build` (9/9), `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T12:24:56.653Z claimed by agent-t025
- 2026-10-13T12:47:53.755Z completed on task/T-025-core-foundations-tenant-context-authoriz
