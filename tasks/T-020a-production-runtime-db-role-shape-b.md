---
id: T-020a
title: Production runtime DB role (non-owner login role) and boot check
phase: 1
area: infra
status: done
owner: agent-t020a
claimed_at: 2026-10-13T12:24:54.718Z
branch: task/T-020a-production-runtime-db-role-non-owner-log
depends_on: [T-020]
review: required
claimable_by: agent
size: S
paths: [docs/runbooks/environments.md, packages/db/src/runtime-role.ts, packages/db/src/runtime-role.test.ts]
---

# T-020a — Production runtime DB role (non-owner login role) and boot check

**Phase** 1 · **Area** infra · **Size** S · **Review** required · **Claimable by** agent · **Depends on** T-020

## Goal

In staging and production the app connects as a login role that is not the table owner and has no
BYPASSRLS ("shape B" in `packages/db/README.md`), so even a raw query that never set a tenant sees
zero rows.

## Scope

- Runbook (`docs/runbooks/environments.md`): after the first migration on the staging/prod Neon
  branch, create `CREATE ROLE cb_app LOGIN PASSWORD '<generated>' INHERIT IN ROLE app_rw, app_platform;`
  and set the runtime `DATABASE_URL` (pooled) to that role; `DATABASE_URL_UNPOOLED` (migrations only)
  stays the owner. Rotation steps for the new password.
- `packages/db/src/runtime-role.ts`: `checkRuntimeRole(db)` that reports if the connected session
  user owns any table in `public`, is superuser or has BYPASSRLS; T-025/apps/web can call it at boot
  in production and log/alert (not crash previews, which use the Neon integration's owner URL).

## Out of scope

- Changing preview environments (the Vercel–Neon integration writes owner URLs; shape A is fine there).

## Acceptance criteria

- [x] Runbook documents role creation, variable placement and rotation.
- [x] `checkRuntimeRole` flags an owner/BYPASSRLS session and passes for a shape-B role (integration test).

## Tests required

- Integration test with the @cb/db harness (`createLoginRole()` gives a shape-B URL).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `docs/runbooks/environments.md`
- `packages/db/src/runtime-role.ts`
- `packages/db/src/runtime-role.test.ts`

## References

PLAN §9.1, E-03, T-020 completion notes, `packages/db/README.md` "Who connects as whom".

## Completion notes

**What exists**

| File | What |
|---|---|
| `packages/db/src/runtime-role.ts` | `checkRuntimeRole(db)` boot check (exported from `@cb/db`, with `RuntimeRoleReport`, `RuntimeRoleIssue`, `RuntimeRoleIssueCode`, `OwnedObject`, `MAX_LISTED_OBJECTS`). |
| `packages/db/src/runtime-role.test.ts` | 13 integration tests (two DB suites), see Verification. |
| `docs/runbooks/environments.md` | New **§4.12** "Runtime database role `cb_app`": why, which URL goes where per environment, password generation, exact SQL, runtime URL, verification command, Vercel switch, post-deploy check, zero-downtime rotation, leaked-password procedure. §3 matrix, §4.2 step 7, §4.10 and §7 (rotation table) updated to match. |

**API**

```ts
import { checkRuntimeRole, createDb } from "@cb/db";
const report = await checkRuntimeRole(db); // db: DbClient (only withTenant/withPlatform are used)
// → { ok: boolean, sessionUser: string | null, database: string | null, issues: RuntimeRoleIssue[] }
// issue: { code, severity: "error" | "warning", message, role?, objects?, count?, targets? }
```

- `error` codes: `superuser`, `bypassrls`, `createrole`, `createdb`, `replication`, `owns_objects`
  (tables/views/sequences/functions/schemas in any non-system schema, or the database itself, owned
  by the session user **or by a role it is a member of**, MEMBER even without INHERIT, since it
  could `SET ROLE` to it; first 20 listed plus `count`), `can_create_objects` (CREATE on the database or
  a schema), `cannot_assume_role` (`role`: `app_platform`/`app_rw`; the role switch failed with 42501/22023,
  so `withTenant`/`withPlatform` would fail).
- `warning` code: `inherits_app_roles` (role inherits `app_rw`/`app_platform`; see Decisions 2).
- `ok` = no `error` issue. Messages name roles/objects only, never secrets or row data.
- Never throws for a finding. It **rejects** only if the database can't be reached or the catalog
  query fails (not a role finding); callers catch.

**How apps/web / T-025 should call it** (not wired here; apps/web and core aren't in my paths):
once per server instance, where shape B is expected (`VERCEL_ENV === "production"`, plus the
staging custom environment, e.g. via `VERCEL_TARGET_ENV === "staging"`, because Vercel reports custom
environments as `preview`). Never on previews/local/CI (owner URL, so it fails by design). Fire and forget, don't block or
crash boot:

```ts
checkRuntimeRole(db)
  .then((r) => { if (!r.ok) log.error({ issues: r.issues, sessionUser: r.sessionUser }, "unsafe database runtime role"); })
  .catch((error) => log.error({ error }, "database runtime role check failed"));
```

Send `!ok` to Sentry as an alert too. Cost: two short read-only transactions (catalog reads only).

**How it runs through `createDb` (no raw handle, by design):** `withPlatform(fn, { accessMode: "read only" })`
then `withTenant(NIL_UUID, fn, read only)`. Inside them `current_user` is `app_platform`/`app_rw`, but
`session_user` is still the login role (`SET ROLE` never changes it), and `pg_roles`, `pg_class`,
`pg_proc`, `pg_namespace`, `pg_database`, `pg_has_role`, `has_*_privilege` are readable by every role.
So the check needs no new client method and no raw connection. Running both wrappers also proves the
role switch every request does actually works for this login role. If one switch fails, the catalog
is read through the other; if both fail, `sessionUser` is `null` and two `cannot_assume_role` issues
are reported. The tenant transaction uses the nil UUID and reads no tenant table.

**Runbook summary (§4.12):** after the first migration on the prod `main` / non-prod `staging`
branch: `openssl rand -hex 32` → password manager; `psql` as the owner (direct URL; not the Neon SQL
Editor or Console → Roles): `CREATE ROLE cb_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE app_rw, app_platform;`
+ `\password cb_app`; runtime URL = owner's pooled URL with `cb_app` credentials; verify with a
one-line `checkRuntimeRole` command (tested locally against a shape-B role: `"ok": true`, exit 0;
against the owner: exit 1); Vercel staging/Production `DATABASE_URL` = cb_app pooled URL and
`DATABASE_URL_UNPOOLED` **removed from Vercel** (the owner URL lives only in the GitHub environments
for the migrations workflow); previews untouched (shape A). Rotation: create `cb_app_v2` → verify →
switch + redeploy → wait for no connections → `ALTER ROLE cb_app NOLOGIN` → `DROP ROLE` a day later
(notes the Instant Rollback caveat).

**Decisions (reviewer please check)**

1. **Check through the existing wrappers**, not a new raw-handle API (see above).
2. **NOINHERIT instead of the task's `INHERIT`.** Tested on PG 17: with INHERIT, a raw `cb_app`
   query sees zero tenant rows (`areas`), but **every row** of tables with an `app_platform` policy
   (`operators`, and by the same rule `users`, `sessions`, `accounts`, `verifications`, `two_factors`,
   `subscriptions`, …), because policies `TO app_platform` apply to roles that inherit it. With
   NOINHERIT the raw query gets `permission denied` on every app table, while `withTenant`/`withPlatform`
   work unchanged (PG 16+ keeps `SET` separate from `INHERIT` on a membership). The runbook uses
   NOINHERIT; `checkRuntimeRole` still passes an INHERIT role (`ok: true`, as the task asked) but adds an
   `inherits_app_roles` warning. If the product owner prefers INHERIT, only the runbook SQL changes.
3. **Ownership via membership counts** (`pg_has_role(session_user, owner, 'MEMBER')`): a runtime role
   granted the owner role (even NOINHERIT) can `SET ROLE` to it. Tested; switching to `USAGE` makes
   that test fail.
4. **All non-system schemas** are checked (public, app, drizzle, …), not only public/app, plus the
   database and the schemas themselves; also CREATE rights (a role that can create a table would own it)
   and REPLICATION.
5. **`DATABASE_URL_UNPOOLED` leaves Vercel** on staging/production: the app never reads it at runtime
   (it is not in `REQUIRED_IN_PRODUCTION`), so keeping the owner password out of the runtime env costs
   nothing. Migrations use the GitHub environment secret (already in §4.10).
6. Roles are created with psql's `\password` (SCRAM hash only, not in server logs or SQL Editor
   history), with an `ALTER ROLE … PASSWORD` fallback if Neon refuses it. I could not try Neon itself
   from here; the SQL was run on local PostgreSQL 17.

**Default privileges confirmed:** a table + `bigserial` sequence created by the owner (as a later
migration would) **after** the runtime role exists is usable by it through `withTenant` (INSERT using
the sequence, SELECT, UPDATE) with no extra GRANT; `has_table_privilege`/`has_sequence_privilege` are true for
both app roles. Mutation check: revoking the default privileges first makes the test fail with
`permission denied for table t020a_late`. Requires every migration to run as the same owner role
(already a README rule; the runbook repeats it).

**Deviations / shared files touched**

- `packages/db/src/index.ts`: one export block for `./runtime-role` (package entry point, as T-020 did).
- `packages/db/README.md` (T-020/T-021, both done): Shape B paragraph updated to NOINHERIT, points
  to runbook §4.12, and describes the boot check. Smallest change that keeps the README consistent.
- Runbook: new subsection numbered §4.12 (inside §4) so later sections keep their numbers (T-011's
  notes reference "runbook §6").
- Not wired into apps/web: T-025 (claimed now) / apps/web own the boot path; call shown above.

**Follow-ups**

- T-025 / apps/web: call `checkRuntimeRole` at instance start on production and staging (above).
- H-01 / product owner: do runbook §4.12 on staging and production after the migrations workflow
  first runs. Check on Neon that `\password` works for SQL-created roles and that the pooled
  endpoint accepts `cb_app` (both expected; the verification step would show a failure).

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17.11)

- `pnpm --filter @cb/db test` (part of `pnpm test`): 13 files / 104 tests, DB suites really ran (no
  skips). `runtime-role.test.ts` (13): owner/superuser connection flagged (superuser, bypassrls,
  owns_objects incl. the database and schema `app`, can_create_objects, list capped at 20 with a total);
  NOINHERIT runbook role → `{ ok: true, issues: [] }`; INHERIT role → ok with two warnings;
  BYPASSRLS+CREATEROLE+CREATEDB+REPLICATION flagged; owning a table flagged, and so is NOINHERIT
  membership of the owner role; CREATE on `public` flagged; missing `app_platform` → one
  `cannot_assume_role` with the catalog still read via withTenant; no membership → two issues,
  `sessionUser: null`; unreachable DB → rejects; both transactions read-only. End to end with the
  NOINHERIT role: withTenant insert/select on `areas` and withPlatform on `operators` work, report ok;
  raw connection → `permission denied` on areas/operators/users/sessions; raw INHERIT connection →
  0 `areas` rows but both `operators` rows; default-privileges test as above.
- Mutation checks (reverted): `MEMBER` → `USAGE` in the ownership test fails 1 test; revoking default
  privileges fails the default-privileges test.
- Runbook verification command run as written against a local shape-B role (`ok: true`, exit 0), the
  owner (exit 1) and a closed port (error printed, exit 1); `psql` as that role:
  `SELECT count(*) FROM operators` → `permission denied for table operators`.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` 9/9, `pnpm test` 9/9,
  `pnpm build` 9/9, `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`.

## Board log

- 2026-10-13T12:24:54.718Z claimed by agent-t020a
- 2026-10-13T12:36:17.725Z completed on task/T-020a-production-runtime-db-role-non-owner-log
