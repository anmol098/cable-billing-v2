---
id: T-086d
title: Enrol platform admins at creation with a one-time setup link; count every failed code
phase: 4
area: core
status: done
owner: agent-t086d
claimed_at: 2026-10-14T21:26:48.076Z
branch: task/T-086d-enrol-platform-admins-at-creation-with-a
depends_on: [T-086b]
review: required
claimable_by: agent
size: M
paths: [packages/core/src/auth/admin-setup.ts, packages/core/src/auth/admin-setup.test.ts, packages/core/scripts/create-platform-admin.ts, apps/web/src/app/(auth)/admin-setup/**]
---

# T-086d — Enrol platform admins at creation with a one-time setup link; count every failed code

**Phase** 4 · **Area** core · **Size** M · **Review** required · **Claimable by** agent · **Depends on** T-086b

## Goal

Only the person a platform admin account was made for can attach an authenticator to it. Wrong
TOTP codes count toward the account lockout wherever they are typed.

## Scope

T-086b found two gaps and left them out of scope:

1. **Self-enrolment trusts first use.** A new platform admin has a password and no TOTP. They turn
   it on themselves at `/login/2fa/setup` on their first sign-in (T-026). So whoever learns the
   password of an admin who has not enrolled yet can enrol **their own** authenticator first, and
   then owns the account. T-026's open question names the bootstrap ("whoever first signs in with
   that password enrols TOTP").
2. **Some failed codes don't count toward the lockout.** Better Auth's account lockout
   (`twoFactor.failedVerificationCount`, 10 failures → 15 minutes) and its 5-tries-per-challenge
   limit only apply to the **sign-in challenge** branch of `verifyTOTP`. In the **existing-session**
   branch (`verify-two-factor.mjs`: a session cookie, no `two_factor` cookie), a wrong code calls
   only `invalid()`: no counter, no lock. `confirmTwoFactorEnrolment` uses that branch. Today only
   our per-IP limit (`AUTH_RATE_LIMITS.twoFactorPerIp`, 30 / 15 min) applies there.

Proposal (product owner to confirm):

- **Create platform admins with a one-time setup link instead of self-enrolment.**
  - A reviewed CLI (`packages/core/scripts/create-platform-admin.ts`, run by an existing admin or
    an operator of the platform) creates the user **without a usable password**.
  - It prints, or emails, a single-use, short-lived link: hashed token, like password reset.
  - The link page sets the password **and** enrols TOTP in one flow, then signs in with a
    TOTP-verified session (T-086b's mark).
  - `/login/2fa/setup` is no longer offered to platform admins. An admin without TOTP is refused
    at sign-in ("ask for a new setup link").
- **Count every wrong code per user**, whichever branch Better Auth takes:
  - Add a per-user key to our rate-limit hook for `/two-factor/*` (the user id comes from the
    session or the 2FA challenge), **or**
  - Record failures in `two_factors.failed_verification_count` from our service methods.
  - Decide which, and document it.
- Existing admins who already enrolled are unaffected. An admin who has not enrolled yet is moved
  to the setup link (a one-off step for the coordinator).

## Out of scope

- Step-up TOTP for single sensitive actions (separate decision, T-086b).
- Tenant users' 2FA (optional; T-026 open question).

## Acceptance criteria

- [x] A platform admin account can only get TOTP through its own single-use setup link. Knowing
      the password alone never lets anyone enrol.
- [x] The setup link is single use, expires, and is stored hashed.
- [x] Wrong codes typed while signed in (enrolment, or a code check on an existing session) count
      toward a per-user limit as well as the per-IP one.

## Tests required

- Core integration test, real Better Auth over the test DB:
  - The setup link enrols once; a second use, an expired link, or a made-up link is refused.
  - A password-only sign-in of an admin who has not enrolled is refused.
  - 10 wrong codes on the existing-session branch lock the account.
- Playwright: admin created by the script → setup link → console.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `packages/core/src/auth/admin-setup.ts`, `packages/core/src/auth/admin-setup.test.ts`
- `packages/core/scripts/create-platform-admin.ts`
- `apps/web/src/app/(auth)/admin-setup/**`
- The smallest changes in `packages/core/src/auth/auth.ts` (rate-limit key, refusing
  self-enrolment for platform admins) and `apps/web/e2e/admin.spec.ts`. T-026, T-086 and T-086b
  are done.

## References

PLAN §9.2, §12.4; T-026 (open question "Platform admin bootstrap"), T-086b completion notes.

## Completion notes

**What Better Auth 1.7.7 does (read in the installed source, not guessed)**

- `plugins/two-factor/verify-two-factor.mjs`: `verifyTwoFactor(ctx)` first calls `getSessionFromCtx`.
  With a session, it returns the **existing-session branch**: `valid()` returns the old token and
  creates nothing, and `beginAttempt` returns no-op `recordFailure` / `restore`. With no session it
  reads the signed `two_factor` cookie (the **sign-in challenge branch**), whose `beginAttempt` keeps
  the 5-tries-per-challenge counter.
- `totp/index.mjs` (`/two-factor/verify-totp`) and `backup-codes/index.mjs`
  (`/two-factor/verify-backup-code`) call `assertTwoFactorNotLocked`, `recordTwoFactorFailure` and
  `resetTwoFactorFailures` only `if (isSignIn)`. `otp/index.mjs` loads the `twoFactor` row only when
  `isSignIn`, so its failure count and lock check also skip the existing-session branch.
- The lockout itself (`recordTwoFactorFailure`) is an atomic `incrementOne` of
  `two_factors.failed_verification_count`, then `locked_until = now + duration` once the count
  reaches `maxFailedAttempts` (defaults 10 and 900 s, `resolveAccountLockoutConfig`).
- `api/dispatch.mjs`: an endpoint's thrown `APIError` becomes `context.returned`, and the after hooks
  still run (the user `hooks.after` first). `asResponse` is forced off for the handler, so a
  successful `ctx.json(...)` is the plain `{ token, user }` object.
- `getSessionFromCtx` caches into `ctx.context.session` and may refresh the session, so the hooks
  don't call it.
- The `twoFactor` plugin's sign-in after hook creates the password session first and then deletes
  it for a user with `twoFactorEnabled`. That's why `databaseHooks.session.create.before` runs for
  every password sign-in and is the right place to refuse an admin without TOTP.
- `internalAdapter.findVerificationValue` deletes **every** expired `verifications` row on each
  call. Expired setup links are swept along with the rest (they are dead anyway).
- `@better-auth/utils/otp` (0.4.2, the exact version better-auth 1.7.7 depends on) `verify` checks
  ±1 period. It keeps no record of used codes (no replay protection).

**What changed**

| Where | What |
|---|---|
| `packages/core/src/auth/admin-setup.ts` (new) | `createPlatformAdmin(deps, { email, name, login, language, by })`: inserts a platform admin with an **unusable password**, returns `{ userId, token, expiresAt }`. `reissueAdminSetupLink(deps, { email, by })`: for an active admin **without** TOTP; replaces their password with an unusable one and removes their sessions, any half-made `two_factors` row and older links. `by: AdminSetupIssuer` is `{ kind: "admin", email }` or `{ kind: "bootstrap", osUser, host }` (review fix 1 below). Both throw `AdminSetupIssueError` (`invalid_input`, `already_exists`, `not_found`, `not_a_platform_admin`, `disabled`, `already_enrolled`, `issuer_not_allowed`, `bootstrap_not_allowed`). Both audit `auth.admin_setup_link_issued` `{ reissued, by, os_user?, os_host? }` with the issuer as actor. `adminSetupUrl(base, token)` → `<base>/admin-setup#<token>`, `adminSetupBaseUrlProblem(url)`, `ADMIN_SETUP_PATH`, `ADMIN_SETUP_LINK_TTL_SECONDS` (1 h). `createAdminSetupService({ auth, db, rateLimiter, logger?, now? })` returns `inspect(token)`, `start({ token, headers })` → `{ email, secret, totpUri, keyId }`, and `complete({ token, keyId, password, code, headers })`. |
| `packages/core/scripts/create-platform-admin.ts` (new) | `pnpm --filter @cb/core admin:create -- --email … --name … [--login …] [--language en\|hi] [--base-url …]`, or `--reissue --email …`. Prints the link; exit 0 / 1 failed / 2 refused. |
| `apps/web/src/app/(auth)/admin-setup/**` (new) | `/admin-setup#<token>`: `noindex`, `referrer: no-referrer`. The server page is the same for everyone (the token is in the fragment). In the browser the page takes the token out of the address bar, checks the link with a Server Action, then **Start** (POST) shows a fresh key and **Turn on and sign in** (POST) takes the new password twice and the first code, then goes to `/admin`. The token travels only in the actions' bodies. A used, expired, unknown or missing link shows one sentence and no form; a key replaced elsewhere shows "The key changed. Press Start again." `setup-flow.test.tsx` covers en/hi, the errors and how the token is handled. |
| `packages/core/src/auth/auth.ts` | See "Security decisions" below. Also: new failure code `SETUP_LINK_REQUIRED`; `TOTP_OPTIONS` and `TWO_FACTOR_LOCKOUT` exported; the twoFactor plugin now gets `accountLockout` explicitly (same numbers as its defaults). |
| `audit-events.ts`, `audit-query/actions.ts`, `audit.json` en/hi | Actions `auth.admin_setup_link_issued` and `auth.admin_setup_completed`. Platform events only, never in a tenant's log. |
| `auth.json` en/hi, `form-state.ts`, `login/page.tsx` | Error `setup_link_required` ("… Ask for a new setup link."), notice `admin_setup_done`, words `admin_setup.*`. Every Hindi string is in `_review`. |
| `apps/web/src/lib/auth/server.ts` | `getAdminSetupService()` singleton. |
| `packages/core/package.json` | `@better-auth/utils` 0.4.2 (the version better-auth pins; already in the lockfile), `tsx` (catalog), script `admin:create`. `tsconfig.json` now includes `scripts`. |

**Security decisions (reviewer please check)**

1. **Enrolment only through the link.**
   - `databaseHooks.session.create.before` refuses a platform admin whose `two_factor_enabled` is
     false. This runs after the password was proven right. The answer is `SETUP_LINK_REQUIRED`, and
     `auth.sign_in_blocked` is audited with `{ reason: "admin_setup_required" }`. So no
     password-only admin session can exist, and there is nothing to self-enrol from.
   - `getSession` also revokes such a session (`admin_setup_required`). This covers sessions from
     before this change.
   - `startTwoFactorEnrolment` and `confirmTwoFactorEnrolment` refuse `platform_admin` with
     `SETUP_LINK_REQUIRED`, before anything else.
   - Tenant users are unchanged: their self-enrolment still works (the service supports it; the UI
     doesn't route them to it).
2. **The link.**
   - The token is 32 random bytes (base64url). Only `cb-admin-setup:` + SHA-256(token) is stored, in
     Better Auth's `verifications` table, which is documented as the table for "password-reset and
     similar one-time tokens", platform path only. So: **no new table, no migration, no new
     platform grant**. T-086c's allow-list and the `@cb/db` harness test are untouched and pass.
   - The row's `value` is `{"userId":…,"secret":null|<encrypted>}`.
   - The link expires after 1 hour, checked against the service clock on every read and on the
     consume.
   - A new link for the same admin removes the older ones.
3. **Start / Done.**
   - A GET never makes or shows a key (an email link scanner learns nothing). Each Start makes a new
     random secret (`generateRandomString(32)`, as Better Auth's `enableTwoFactor` does) and stores it
     encrypted with Better Auth's `symmetricEncrypt` and `secretConfig`, replacing the previous one.
     If someone else holding the link presses Start, the real admin's key is invalidated, never
     revealed.
   - Done checks the code against the stored secret. Then **one** platform transaction:
     1. deletes the link row only if it is unexpired **and** still holds the exact value that was
        checked. 0 rows → `INVALID_TOKEN`. Changed in between → rollback → `INVALID_CODE`;
     2. re-checks the user `FOR UPDATE` (active platform admin, TOTP off);
     3. sets the credential password (argon2id);
     4. writes `two_factors` (`verified`, count 0, backup codes = encrypted `[]`: the backup-code
        endpoint isn't reachable, so no codes are shown or kept);
     5. sets `users.two_factor_enabled`;
     6. ends every session of the user and removes the user's other links.
   - Two concurrent Done requests: exactly one wins (tested).
4. **Sign-in after setup.** The service calls `signInEmail` with the request headers **minus the
   browser's cookies**, so another user's session in that browser can't turn the TOTP step into an
   existing-session check. It takes the `two_factor` cookie from that response and calls the
   normal `verifyTwoFactor` with the same code. The session is therefore made by
   `/two-factor/verify-totp` and carries T-086b's `two_factor_verified_at`, through every usual
   gate, and `auth.signed_in { method: password_totp }` is audited. If that step fails, the setup
   still stands and the page sends the admin to `/login?notice=admin_setup_done`.
5. **Every wrong code counts per user.** Of the two options in the task, I chose the second:
   record failures in `two_factors.failed_verification_count`.
   - The first option, a per-user key in our rate limiter, would count attempts rather than
     failures. It would be a second, fail-open counter (Upstash outages) that Better Auth's lock
     doesn't see.
   - This option uses **one counter and one lock for both branches**. Nothing is counted twice:
     Better Auth counts the sign-in branch, our hooks count only the existing-session branch.
   - How it works:
     - `rateLimitHook` (before), for the three verify paths: when a signed session cookie maps to an
       unexpired session row, i.e. Better Auth's existing-session branch, it refuses while
       `locked_until > now` (`ACCOUNT_TEMPORARILY_LOCKED` → `RATE_LIMITED` with `retryAfter`). It
       clears an expired lock, like `assertTwoFactorNotLocked`.
     - `hooks.after` (`twoFactorLockoutAfter`): on that endpoint's wrong-code error
       (`INVALID_CODE` / `INVALID_BACKUP_CODE`) in the existing-session branch, it does an atomic
       `+1`, then sets `locked_until` at 10. This mirrors `recordTwoFactorFailure`. A right code
       resets the count, like `resetTwoFactorFailures`.
   - The branch is determined the same way Better Auth does it: signed cookie → session row with
     `expires_at > now`. A wrong code changes no session, so the before and after hooks agree with
     the endpoint.
   - It is keyed on the endpoint path, so it covers any caller of `auth.api.verifyTOTP`, not only
     our two service methods.
   - Per-IP 30 / 15 min is unchanged.
6. **Rate limits on the link page:** Start and Done each count toward `admin-setup:ip`
   (`AUTH_RATE_LIMITS.resetPerIp`, 20 / h), fail-open like the other auth limits. Wrong codes on the
   link page are **not** counted per user. The key is shown only to whoever holds the link, so
   guessing it gains nothing, and there is no `two_factors` row yet.

**Deviations / files outside the owned paths** (all needed, smallest edits)

- `packages/core/src/auth/{audit-events,index}.ts`, `audit-query/actions.ts`,
  `packages/i18n/messages/{en,hi}/{auth,audit}.json`, generated `apps/web/messages/*.json`.
- T-026 / T-086b files (done):
  - `apps/web/src/lib/auth/server.ts` (singleton);
  - `(auth)/login/_components/form-state.ts` (new error key);
  - `(auth)/login/page.tsx` (new notice);
  - `apps/web/e2e/auth.spec.ts`: the admin self-enrolment test became the refusal test. `totp()` and
    `createHmac` are now unused there and were removed.
- `packages/core/src/auth/auth.test.ts`:
  - The admin self-enrolment tests became link-based: refusal at sign-in → link → code at every
    sign-in → 8-hour cap, with the audit sequence.
  - T-086b's admin guards are still tested: a session row without the TOTP mark is refused by
    `resolveAdminContext` and revoked by `getSession`.
  - The incomplete-enrolment test now uses an owner, since admins can't self-enrol any more and
    the mechanism is role-agnostic.
  - The audit-trail test allows the CLI's event to have no IP and no user agent.
- `apps/web/e2e/admin.spec.ts`: the admin is now made by the script. The T-086b two-browser
  scenario (a password-only admin session from before enrolment) **can't happen any more** (an
  unenrolled admin gets no session), so that e2e test was replaced by "an admin without 2-step
  sign-in never gets in". The core tests keep the T-086b guards covered.
- Not changed: `/login/2fa/setup` and `startEnrolmentAction` stay, for tenant users (the service
  supports them). For admins they're unreachable (no session without TOTP, and the service refuses
  them). `requirePlatformAdmin`'s redirect to the setup page and `WebSession.twoFactorEnrolmentRequired`
  are now always false for admins. I left them alone rather than touch more T-026 code.

**One-off step for the coordinator**

Any platform admin who exists today without TOTP can no longer sign in. Give them a link:

`DATABASE_URL=… APP_BASE_URL=https://<app> pnpm --filter @cb/core admin:create -- --by <your enrolled admin email> --reissue --email <their email>`

If no platform admin has 2-step sign-in yet, use `--bootstrap` instead of `--by` for the first one.

Send the printed link over a channel only they read. It works once, for 1 hour. Admins who already
enrolled are unaffected.

**Open questions (product owner)**

- Link lifetime is 1 hour, like password reset. Is that too short for a link sent by hand? The
  command can be re-run at any time.
- The script prints the link and doesn't email it. Should it email it (Resend) instead?
- Lost authenticator: `--reissue` refuses an admin with TOTP on. Recovery today means turning their
  TOTP off in the database, then `--reissue`. Should the CLI do this with a reason, audited?
- Backup codes for admins: none are made or shown. Better Auth's backup-code endpoint is not
  reachable (T-086b).

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp`
3ccab93, after T-086c and T-087b)

- `@cb/core` `auth/admin-setup.test.ts` (9, real Better Auth over the test DB):
  - Admin made with no password: nobody can sign in before the link is used.
  - Only SHA-256 is stored; the token appears in no row or log; expiry is ≤ 1 h.
  - Done before Start → `INVALID_CODE`. The stored secret is encrypted.
  - Wrong code or short password → refused, and the link still works.
  - Done → signed in with a TOTP-verified session that `resolveAdminContext` accepts.
  - A second use (`inspect`, `start` or `complete`) → refused.
  - Later sign-ins: password, then the code.
  - Audit: `link_issued, setup_completed, signed_in, signed_in`, all platform events.
  - Expired link (clock + 1 h + 1 s), made-up token and malformed tokens → `INVALID_TOKEN`, with
    no TOTP row written.
  - Start pressed again → the old key's code is refused.
  - Two concurrent Done requests → exactly one wins.
  - Legacy admin (password, no TOTP): the right password → `SETUP_LINK_REQUIRED` by login and by
    email, no session, `sign_in_blocked { reason }`; a wrong password still gets
    `INVALID_CREDENTIALS`. Reissue removes the password and sessions and kills the older link; the
    new link works.
  - Refusals: `already_enrolled`, `not_a_platform_admin`, `not_found`, `already_exists`,
    `invalid_input`.
  - An enrolled admin's `start`/`confirmTwoFactorEnrolment` → `SETUP_LINK_REQUIRED`. With TOTP
    turned off by hand, `getSession` revokes the session (`admin_setup_required`).
  - **10 wrong codes in a signed-in browser** (existing-session branch) → count 1…10, then
    `locked_until` ≈ +15 min. The right code is then `RATE_LIMITED` there **and** at a fresh
    password + code sign-in elsewhere (Better Auth's own lock check). Once the lock runs out, the
    right code works and the count is 0.
  - One counter: a sign-in-branch failure counts 1 (not 2), an existing-session failure +1, and a
    right code resets it.
  - **Owner enrolment**: 10 wrong `confirmTwoFactorEnrolment` codes → locked; the right code is then
    `RATE_LIMITED` and TOTP stays off.
- `auth/auth.test.ts`: 21 tests pass, with the changes above.
- Mutation checks (each reverted), every one caught by a failing test:
  - sign-in gate off → 2 tests fail;
  - `getSession` admin check off → 1;
  - admin refusal in `start` → 1, and in `confirm` → 1;
  - no lock check in the existing-session branch → 2;
  - existing-session failures not counted → 3;
  - no lock at the limit → 2;
  - link expiry ignored → 1;
  - token stored in plain → 1;
  - wrong code accepted → 2;
  - link not consumed (no delete, no cleanup) → 1. A first version of this mutation, which
    re-inserted the row, was neutralised by the same transaction's cleanup of the user's other
    links and by `liveLink` refusing an enrolled admin, so I repeated it as a real removal.
- `@cb/web`: `setup-flow.test.tsx` (4) plus the existing login tests.
- Root:
  - `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10) and `pnpm build` (10/10)
    pass.
  - `TURBO_FORCE=1 pnpm test --concurrency=1`: 10/10 packages. `@cb/core` 1284 passed + 3 skipped,
    `@cb/db` 273 (incl. T-086c's `harness.test.ts`), `@cb/web` 606.
  - `pnpm generate` leaves no diff. The tokens/icons/i18n/openapi `--check` modes, `db:check` and
    `tasks.mjs check --local` pass.
- Playwright (`next start`, a freshly migrated scratch DB, pre-installed Chromium, `E2E_PORT=3486`):
  `admin.spec.ts` + `auth.spec.ts` + `audit.spec.ts` **14/14**, before and after the rebase. This
  includes:
  - the real `admin:create` script → setup link → Start → a wrong code (the key stays; the
    passwords are retyped) → the right code → `/admin` Overview;
  - the link opened again → "does not work any more";
  - the platform audit events;
  - a legacy admin refused at sign-in on every admin route;
  - the existing console flow, signing in with the code.

**Review fixes (coordinator review of PR #92)**

1. **Who issued a link is the actor.**
   - `admin:create` now needs one of two options:
     - `--by <email>`: checked in the issuing transaction to be an active platform admin with TOTP
       on, else `issuer_not_allowed`;
     - `--bootstrap`: only while no active, enrolled platform admin exists, else
       `bootstrap_not_allowed`. It takes a transaction advisory lock, so two bootstraps can't race.
   - `recordAuthEvent` takes an optional `actor` (default: the subject; `null`: the system).
     `auth.admin_setup_link_issued` now has:
     - actor = the `--by` admin, or the system for `--bootstrap`;
     - entity = the new admin;
     - `after { reissued, by: "admin" | "bootstrap", os_user?, os_host? }` (the OS user and host
       only for bootstrap).
   - Sentence: "{who} made a one-time setup link for a platform admin" (en/hi, Hindi in
     `_review`). With the system as actor, {who} reads "The app".
2. **Login-name timing.** Better Auth 1.7.7 behaves differently by sign-in path:
   - username sign-in (`plugins/username/index.mjs`) throws at once, with no hash, when the user has
     no credential account;
   - email sign-in (`api/routes/sign-in.mjs`) hashes a dummy in that case.

   New and reissued admins now get a credential row whose password is `hashPassword` of 32 random
   bytes. Sign-in therefore verifies (and logs "Invalid password") like any wrong password. Reissue
   *replaces* it (no longer deletes it); the setup link still overwrites it. Only two places read
   the credential row:
   - T-032's Team page (`passwordSet`), which only lists the tenant's own users, never admins;
   - the lineman mobile sign-in (`mobile-auth.ts`), linemen only.

   Neither treats this row as "has set a password" for an admin.
3. **Token out of URL paths.**
   - The link is `/admin-setup#<token>`. Browsers never send the fragment, so the server, Vercel's
     request logs and Sentry never see the token in a URL.
   - `/admin-setup` renders the same neutral page for everyone. In the browser, the page takes the
     token from `location.hash`, removes it at once with `history.replaceState`, checks the link
     with a Server Action (`checkAdminSetupLinkAction`), and sends the token only in the POST
     bodies of check / Start / Done.
   - `referrer: no-referrer` and `noindex` are kept. The `[token]` route is gone. The CLI output,
     the tests and Playwright are updated.
   - Playwright checks that no request URL the browser made contained the token.
4. **A failed reset can't fail a right code.** In `twoFactorLockoutAfter`, only the success-branch
   reset is wrapped in try/catch (`auth.two_factor_reset_failed`, error log). Failure counting stays
   strict.
5. **Accepted (defence in depth):** a burst of parallel wrong codes in the existing-session branch
   can all pass the before-check before any is counted. It needs a valid session, and the per-IP
   limit (30 / 15 min) still applies. Each one is still counted afterwards.
6. **Accepted risk (unchanged Better Auth behaviour):** someone who knows an admin's password can
   keep that admin's 2-step sign-in locked, in 15-minute steps, by typing wrong codes at the
   sign-in challenge.
7. **The key changed.**
   - "Start" returns a random `keyId`, stored with the encrypted secret. "Done" must send it back.
   - When it doesn't match the link's current key, or Start was never pressed, the answer is the
     new code `SETUP_KEY_CHANGED`: "The key changed. Press Start again." / "की बदल गई है। फिर से
     “शुरू करें” दबाएँ।" (Hindi in `_review`).
   - The same answer covers the race where Start is pressed again during Done's transaction. The
     page then shows the Start step again.
   - An old key's code never gets `INVALID_CODE` any more.
8. **https only:** the CLI refuses a base URL that isn't an `https://` origin, except
   `http://localhost` / `127.0.0.1` / `[::1]` (`adminSetupBaseUrlProblem`).
9. **Password limits:** the setup form gets `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` as
   props from the server page. Importing `@cb/core` into a client component would bundle server
   code.

**Verification of the review fixes** (rebased on `feature/mvp` 8f7755a, after #93)

- `admin-setup.test.ts`: 11 tests. New or changed:
  - the base-URL rule;
  - the unusable argon2id credential, for create and reissue;
  - sign-in by email **and by login name** logs "Invalid password", which proves the password
    verify ran;
  - Done before Start, and Done with an old key id → `SETUP_KEY_CHANGED`;
  - every issued event's actor, role and `after` (root bootstrap = system, with OS user and host;
    the others = the root admin);
  - `bootstrap_not_allowed` once an admin has enrolled;
  - `issuer_not_allowed` for an unenrolled admin, an owner, a disabled admin, an unknown address,
    and an admin issuing for themselves;
  - a refused issue changes nothing.
- `auth.test.ts`: links are issued by a bootstrapped root admin.
- `setup-flow.test.tsx`: 7 tests:
  - the token is read from `#`, gone from `location`, and sent in the action bodies;
  - key changed → the Start step again, then the new key with no stale error;
  - a missing `#` asks nothing of the server;
  - en/hi.
- Mutation checks (each reverted), every one caught:
  - anyone may issue;
  - bootstrap allowed after an admin enrolled;
  - actor back to the subject (3 tests fail);
  - no credential row for a new admin;
  - reissue deletes the credential row;
  - key id not checked;
  - http base URL allowed anywhere;
  - token left in the address bar;
  - no Start-again step.

  The reset try/catch (4) has no automated test: it needs a database failure injected between
  Better Auth's session creation and the reset.
- Root checks:
  - `pnpm install --frozen-lockfile`, lint, typecheck, build, `pnpm generate` (no diff), the
    `--check` modes, `db:check` and `tasks.mjs check --local` pass.
  - `TURBO_FORCE=1 pnpm test --concurrency=1`: 10/10 packages. `@cb/core` 1286 passed + 3
    skipped, `@cb/db` 273 (incl. the harness), `@cb/web` 615.
- Playwright on a fresh scratch DB: `admin.spec.ts` + `auth.spec.ts` + `audit.spec.ts` **14/14**.
  The script runs with `--by` a seeded enrolled admin. The `#` link works, the address bar loses
  the token, no request URL contains it, and the issued event's actor is the issuing admin.

## Board log
- 2026-10-14T21:26:48.076Z claimed by agent-t086d
- 2026-10-14T22:07:09.070Z completed on task/T-086d-enrol-platform-admins-at-creation-with-a
