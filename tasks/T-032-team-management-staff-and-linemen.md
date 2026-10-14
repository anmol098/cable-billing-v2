---
id: T-032
title: Team management (staff and linemen)
phase: 1
area: web
status: done
owner: agent-t032
claimed_at: 2026-10-13T19:33:02.627Z
branch: task/T-032-team-management-staff-and-linemen
depends_on: [T-029, T-028]
review: self
claimable_by: agent
size: M
paths: [apps/web/src/app/(operator)/settings/team/**, packages/core/src/team/**, packages/i18n/messages/*/team.json]
---

# T-032 — Team management (staff and linemen)

**Phase** 1 · **Area** web · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-029, T-028

## Goal

Owner adds staff and linemen, resets lineman passwords and signs out lost phones.

## Scope

- Add staff (email + temp password or invite email) and lineman (login suggestion = mobile number, simple password, show-password).
- 'Share login on WhatsApp' button (wa.me link with login + app link; password NOT included).
- Reset lineman password (Owner sets new), deactivate user, list lineman phones (model, last seen, app version) with 'Sign out this phone'.

## Acceptance criteria

- [ ] Deactivated lineman's refresh fails; queued payments still accepted with review flag (contract with T-061).
  - [x] **This task's half:** switching a lineman off revokes every mobile refresh token (`user_disabled`) in the same transaction, so refresh fails at once (REFRESH_TOKEN_INVALID), the next bearer request gets ACCOUNT_DISABLED and sign-in gets ACCOUNT_DISABLED; nothing is deleted (user, credential, devices, payments stay). Tested in `team.test.ts` and `e2e/team.spec.ts`.
  - [ ] **T-061's half (not done here):** a switched-off lineman's payments still queued on the phone being *accepted with a review flag*. Today (T-066) the phone holds them and never sends them under another sign-in; the server side and the release decision belong to T-061 (see Completion notes). Left unticked until T-061 lands.

## Tests required

- Service tests + isolation cases.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/web/src/app/(operator)/settings/team/**`
- `packages/core/src/team/**`
- `packages/i18n/messages/*/team.json`

## References

D-07, D-16, PLAN §11.6 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists**

| Where | What |
|---|---|
| `packages/core/src/team/team.ts` | Services `listTeam` (`team.list`, capability **`team.view`**), `addLineman` (`team.add_lineman`), `addStaff` (`team.add_staff`), `resetMemberPassword` (`team.reset_password`), `deactivateMember` (`team.deactivate`), `reactivateMember` (`team.reactivate`), all `team.manage` except the list. "Sign out this phone" reuses T-028's `revokeDevice`. |
| `packages/core/src/team/rules.ts`, `fields.ts` | Pure rules: `linemanPasswordProblem` (6+ chars; refuses repeats like `111111`/`121212`, straight runs `123456`/`abcdef`, a short common list, and the user name / mobile itself), `staffPasswordProblem` (web rule 8+, same checks), `passwordProblemFor(role, …)`, `normalizeLogin`/`loginProblem` (3–100, `a-z0-9._-`, no `@`), `suggestedLoginCandidates(mobile)` (mobile, `-2` … `-10`), `suggestLinemanPassword(randomInt)` (6 random digits passing the rules), `checkLinemanFields` / `checkStaffFields` (every field problem at once; codes, never values). |
| `packages/core/src/team/team.isolation.ts` | Isolation cases for the list (`no_leak`), new password, switch off, switch on (NOT_FOUND + no change). Add lineman/staff are exempt with a reason (no input id; the cross-tenant login/email collision is covered in `team.test.ts`). |
| `packages/core/src/auth/auth.ts` (T-026, done) | `requestPasswordReset({ email, headers, invite? })` + `PasswordResetEmail.invite` / `PasswordResetInvite`: the same single-use reset link, flagged as an invitation so the web words it differently. No behaviour change without `invite`. |
| `packages/core/src/authz/capabilities.ts` (T-025, done) | New capability **`team.view`** (Owner, read, not audited) + its hand-written cells in `capabilities.test.ts` / `writable.test.ts`. Why: the list is a read (works in read-only mode, D-13 "viewing"), but must stay Owner-only; `dashboard.view` would let Staff call it. |
| `apps/web/src/app/(operator)/settings/team/` | `page.tsx` (Owner only: `canSeeRoute` → 404 for Staff, as the placeholder did), `actions.ts` (6 Server Actions), `action-state.ts` (service error → words, pure), `share.ts` / `share-url.ts` (wa.me link), `rows.ts` (view rows, IST times via T-062's `whenText`), `team-manager.tsx`, `dialogs.tsx`, `fields.tsx`, `team.test.tsx`. |
| `apps/web/src/lib/auth/invite-email.ts` (+ test), `server.ts` (T-026, done) | The staff invitation email (en/hi, `team.email.*`); `server.ts` sends it instead of the reset email when `email.invite` is set. |
| `packages/i18n/messages/{en,hi}/team.json` | All words; every Hindi string is in `_review` (H-03). Glossary: new "Team words" section. |
| Icons (`icons.json`, T-003 done) | `device` (smartphone), `switch-off` (user-x), `switch-on` (user-check); regenerated web + Android drawables. |
| `apps/web/e2e/team.spec.ts` | The Playwright flow (below). |

**Service API** (all `service.call(runtime, ctx, input)`; Owner only; errors `VALIDATION` with `details.fields: [{ path, code }]`, `CONFLICT` with `details.reason`, `FORBIDDEN`, `NOT_FOUND`, `TENANT_READ_ONLY`)

- `listTeam({})` → `{ members: TeamMemberView[], selfUserId, editable, readOnlyReason }`. Members: Owner first, then linemen, then staff; active first; by name. Each has `passwordSet` (a credential exists; false for invited staff) and, for linemen, `phones: { id, deviceCode, model, osVersion, appVersion, appVersionCode, lastSeenAt, signedOutAt, signedIn }` (`signedIn` = not revoked and a live, unrotated, unexpired refresh token for that lineman on that device).
- `addLineman({ name, mobile, login?, password, language = "hi" })` → `AddedMember { userId, role, login, loginChanged, name, phone, email, language, invite }`. Empty `login` → the mobile; if another **business** already uses it, `<mobile>-2` … `-10` (`loginChanged: true`, nothing about the other tenant is revealed). A login already used **in this team** stops at once: CONFLICT `login_in_team` with that member's `userId` (adding the same person twice). A typed login used elsewhere: CONFLICT `login_taken`.
- `addStaff({ name, mobile?, email?, login?, setup: "password" | "invite", password?, language = "en" })`: login defaults to the mobile, else the email's first part. `invite` creates the user **without** a credential; the Server Action then calls `getAuthService().requestPasswordReset({ email, headers, invite: { businessName, login } })` after commit. Email used by any account → CONFLICT `email_taken`.
- `resetMemberPassword({ userId, password })` → `{ revokedTokens, endedSessions }`: role's password rule, credential replaced (or created), mobile refresh tokens revoked `password_changed`, web sessions deleted. Works on a switched-off person (they stay off).
- `deactivateMember({ userId })` / `reactivateMember({ userId })` → `StatusChange { status, unchanged, revokedTokens, endedSessions }`. Off: `status = 'disabled'`, sessions deleted, tokens revoked `user_disabled`, never deleted. On: status back to active; earlier sign-ins stay ended (phones/browsers sign in again with the password). Both idempotent (`audit.skip("no_change")`). The Owner's own account (and any owner) → FORBIDDEN `owner_account`.

**Decisions**

1. **Lineman password rule** (D-07, low literacy): 6+ letters or numbers so a 6-digit number works; only the passwords anyone tries first are refused (repeats, straight runs, a short list, the user name/mobile). Show-password is **on by default** in the Owner's dialogs (they type it to tell the lineman). "Make one for me" fills a random 6-digit password made on the server (`node:crypto` `randomInt`) per page render. Sign-in stays rate limited per account (T-026/T-028). Staff keep the web's 8+ rule.
2. **Staff invite = the reset link worded as an invitation** (reusing Better Auth's single-use, hashed, 1-hour reset token). No new token type or table. The email says the link works for 60 minutes and, after that, to use "Forgot password?" (works for any active staff with an email). The page shows "Has not set a password yet" until they do. The "added" screen says "We are emailing a link…" (sending runs after the response; a rate-limited request says the email could not be sent now).
3. **Owner can set a new password for staff too** (T-026's open question "staff without an email can't reset by email"), with the web rule.
4. **Share on WhatsApp:** `https://wa.me/91<mobile>?text=…` (or `wa.me/?text=` without a usable mobile). Message in the **lineman's** language: business, app link, user name, "Password: the owner will tell you". **Never the password** (tested in unit, component and e2e). The button is a link; after a tap we only say "WhatsApp opened" (CLAUDE.md honest states). The app link is `LINEMAN_APP_URL` (`…details?id=com.cablebilling.lineman`, the T-008 placeholder; change it in `share.ts` when H-02 fixes the applicationId).
5. **Read-only mode:** the Owner still sees the team (`team.view` is a read); every change is refused (`team.manage` is not on the D-13 allowlist), the page shows a notice and no buttons. See open question 2.
6. **Audit** (`team.add_lineman`, `team.add_staff`, `team.reset_password`, `team.deactivate`, `team.reactivate`; `devices.revoke` from T-028): role, name, login, phone/email, language, status, `sign_in_setup` (`set_by_owner` / `email_link`), `revoked_count`, `ended_sessions`. **Never a password or hash** (tested: no password, no `$argon2`, no `"password"` key in any `team.*` row). Logs carry ids, counts and booleans only (strict logger in tests).
7. Linemen's app language is chosen on "Add lineman" (Hindi default, D-06); staff get the Owner's current UI language (their emails).

**Deactivated lineman's queued payments (the AC's second half; depends on T-061)**

- What this task guarantees: switching off never deletes the lineman, their credential, their devices or anything they recorded; their refresh fails at once and sign-in is refused (ACCOUNT_DISABLED). The device stays registered, so payments still on that phone keep their `collector_id` and provisional refs.
- What it does **not** do: get those queued payments to the office. Today T-066's phone **holds** another lineman's payments and never sends them under a different sign-in, and nothing lets a disabled lineman's phone push. T-061 (in flight) owns the server side ("accepted with review flag", e.g. `posted_needs_review` with `collector_inactive`), and the product owner still has to pick between T-066's proposal (Owner releases a phone's held payments from the web; `/app/config` carries `release_held_for`) and T-028's alternative (a disabled lineman's still-registered device may call only `/payments:batch` for a grace period). Whichever is chosen, T-032 needs no change for the server half; the "release" option would add a button on this page (follow-up for whoever builds it).
- Because of that, the "Switch off" confirm says honestly: payments still saved on the phone stay there and are not lost; best switch off after the day's handover (T-028's recommendation). Update that sentence once T-061 sends them.

**Deviations / files outside the owned paths (all small, all done tasks)**

- `packages/core/src/auth/auth.ts` + `auth/index.ts` (T-026): the `invite` option above.
- `packages/core/src/authz/capabilities.ts`, `capabilities.test.ts`, `writable.test.ts` (T-025): `team.view` (security change: one Owner-only read capability).
- `apps/web/src/lib/auth/server.ts` (T-026): pick the invitation email; new `invite-email.ts` (+ test) beside `reset-email.ts` / `signup-email.ts` (as T-027 did).
- `packages/design-tokens/icons.json` + generated icons (3 names), `packages/core/src/index.ts` (one export line), `packages/i18n/glossary.md`, generated `apps/web/messages/*.json`, new `apps/web/e2e/team.spec.ts`.
- `rows.ts` imports T-062's pure `whenText` from `linemen/_lib/format.ts` (same IST time words as the Linemen page) instead of copying it.

**Open questions (product owner)**

1. The queued-payments decision above (T-066 proposal vs T-028 alternative), needed by T-061.
2. **Signing out a lost phone and switching someone off are blocked in read-only mode** (they are `team.manage` writes, not on the D-13 allowlist; T-028's `revokeDevice` already behaved so). They are security actions; consider adding `team.manage` (or a narrower capability for sign-out/switch-off) to the read-only allowlist.
3. Sign-in names and emails are unique across every business, so "this user name/email is taken" tells an Owner that it exists somewhere (no other detail). Same trade-off as T-027's sign-up.
4. Should an invited staff member's link last longer than 1 hour? (Better Auth's reset expiry is one setting for both; a separate token type would be needed.) Should staff be forced to change an Owner-typed first password? (not supported by the auth layer today).
5. The share message wording and the Hindi drafts (H-03); the app link waits on H-02.

**Verification** (Node v24.21.0, pnpm 12.11.2, local PostgreSQL 17; rebased on `feature/mvp` 41642a5, incl. T-030 and T-033)

- `pnpm --filter @cb/core test`: 50 files / 750 tests (1 skipped: T-033's benchmark). New `team/team.test.ts` (18, real DB): add lineman (mobile as login, `+91 …` accepted, argon2id hash, the phone signs in through T-028's service, audit row); **another business has the mobile → `<mobile>-2`, no foreign id in the result, their user untouched**; same-team duplicate → `login_in_team`, nothing written; typed login taken elsewhere → `login_taken`; bad login characters; **password rules** (`12345`, `123456`, `111111`, `abcdef`, the mobile) and every field problem at once, nothing written; staff with a first password signs in on the web, 8+ rule; **invite**: no credential, `passwordSet: false`, the invitation email (`invite` payload), the link sets the password, sign-in works; invite without email; `email_taken`; **new password → both phones' refresh fails (REFRESH_TOKEN_INVALID), access token refused, reason `password_changed`, old password refused, new works**; staff new password ends the web session; Owner account FORBIDDEN, other tenant NOT_FOUND, nothing changed; **switch off → refresh fails, access token ACCOUNT_DISABLED, sign-in ACCOUNT_DISABLED, user/credential/device kept, audit before/after, idempotent second call without a second audit row**, switch on → sign-in works, old refresh still dead; switched-off staff session ended + sign-in refused; Owner can't switch themselves off; list with phones (model, app version, last seen, signed in → signed out after `revokeDevice`), ordering, no other tenant, no hash; read-only tenant: list works (`editable: false`), add → TENANT_READ_ONLY; **Staff and lineman get FORBIDDEN from all 6 services, nothing changes**; **no password/hash in any `team.*` audit row or log record**. `team/units.test.ts` (23): password rules per role, login rules and candidates, email-based login base, field checks, the password suggester. Isolation suite: 4 new cases pass; the coverage test passes (2 documented exemptions). Capability matrix and read-only matrix tests updated by hand.
- `pnpm --filter web test`: 27 files / 258 tests. New `settings/team/team.test.tsx` (16): list with status words/icons, phones, no share link for a switched-off lineman, staff "Has not set a password yet"; share link `href` = the wa.me URL, never the password, toast "WhatsApp opened" and no "sent"; read-only (no buttons, notice); empty lists; Hindi; add lineman (user name follows the mobile, password shown by default, "Make one for me", the call's arguments, the added screen with user name, password note and share link); field errors in words (`aria-invalid`); `<mobile>-2` notice; add staff by invite (no password field, email notice); new password (note, call, done text); switch off confirm in plain words then the call + toast; switch on; sign out phone confirm + NOT_FOUND shown in words; error mapping; every field error key in en+hi; share helpers; mobile grouping. `lib/auth/invite-email.test.ts` (2, en/hi).
- `pnpm --filter web test:e2e` (scratch DB `cb_e2e_t032` migrated, `E2E_PORT=3232`, pre-installed Chromium): **62 passed**, 2 new in `team.spec.ts`: Staff get 404 on `/settings/team`; the Owner adds a lineman (too-simple password refused in words, then saved; user name = mobile, password field shown), shares on WhatsApp (href checked: mobile + Play link, no password; popup to a stubbed wa.me; "WhatsApp opened"), **the phone signs in through `POST /api/mobile/v1/auth/login`** and appears on the page (model + device code, "Signed in"), the page fits **360px** with no sideways scroll (screenshot checked), **new password → refresh 401 REFRESH_TOKEN_INVALID, old password 401, new password 200**, **Sign out this phone → refresh 401 DEVICE_REVOKED**, sign in again, **switch off → refresh 401, sign-in 403 ACCOUNT_DISABLED**, card says "Switched off", the user row still exists (`disabled`), the audit has the four actions and no password/hash.
- Root: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (10/10), `pnpm test` (10/10 with `DATABASE_URL`), `pnpm build` (10/10), `pnpm generate` (no diff), tokens/icons/i18n/openapi `--check`, `node scripts/tasks.mjs check --local`.
- Not verified: a real phone (T-063's app against this page), Hindi read by a person (H-03), the Resend path for the invitation (captured transport only).

## Board log

- 2026-10-13T19:33:02.627Z claimed by agent-t032
- 2026-10-13T20:16:36.739Z completed on task/T-032-team-management-staff-and-linemen
