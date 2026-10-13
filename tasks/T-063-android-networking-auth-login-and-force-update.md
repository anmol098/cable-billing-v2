---
id: T-063
title: Android: networking, auth, login and force update
phase: 3
area: android
status: done
owner: agent-t063
claimed_at: 2026-10-13T11:55:28.078Z
branch: task/T-063-android-networking-auth-login-and-force
depends_on: [T-008, T-009, T-051]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/data/network/**, apps/android/app/src/main/java/com/cablebilling/lineman/data/auth/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/login/**, apps/android/app/src/main/java/com/cablebilling/lineman/feature/update/**, apps/android/app/build.gradle.kts, packages/i18n/messages/*/mobile_login.json]
---

# T-063 — Android: networking, auth, login and force update

**Phase** 3 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-008, T-009, T-051

## Goal

Lineman signs in once and the app talks to the API safely.

## Scope

- DTOs generated from `packages/contracts/openapi.json` (models only) + Retrofit services.
- Token store (Tink/Keystore), auth interceptor with refresh, install_id generation.
- Login screen per PLAN §11.3 (show password default on, 123/ABC toggle, call office).
- Force-update screen from `/app/config`.

## Acceptance criteria

- [x] Works against MockWebServer using contract fixtures (no live server needed).

## Tests required

- Unit tests (refresh race, 401 handling) + Compose UI test for login.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/data/network/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/data/auth/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/login/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/update/**`
- `apps/android/app/build.gradle.kts`
- `packages/i18n/messages/*/mobile_login.json`

## References

PLAN §11.3 (Login), PLAN §11.6, PLAN §11.9, D-07 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`; overview in `apps/android/README.md`)

- `data/network/generated/ApiModels.kt`: **generated** DTOs for every schema in
  `packages/contracts/openapi.json` (`@Serializable` data classes + enums with `wire` and `fromWire`).
  Mapping: strings (ids, `…_at` instants, dates, periods) → `String`; integers → `Long` (paise);
  `anyOf [X, null]` → `X?`; optional → `X? = null`; `features` → `Map<String, Boolean>`; `ErrorCode`
  is an open enum, so `ApiError.code` / `ItemError.code` are `String` (look up with `ErrorCode.fromWire`).
  `ApiContract.VERSION` = contract `1.0.0`.
- Generator: `app/src/test/.../data/network/codegen/ApiModelGenerator.kt` (plain Kotlin, no Node, runs
  in Gradle). `ApiModelsUpToDateTest` regenerates in memory and fails if the committed file differs
  (CI runs it with `testDevDebugUnitTest`; `openapi.json` and `fixtures/` are declared inputs of the
  test task, so a contract change reruns it). Regenerate:
  `./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true`.
- `data/network`: `AuthApi` (login, refresh as blocking `Call`, logout), `MobileApi` (all 9 bearer
  endpoints, `"./payments:batch"`), `apiCall` + `ApiResult` / `ApiFailure`, `ApiErrorParser`,
  `AppVersionInterceptor`, `AuthInterceptor`, `TokenRefresher`, `UpdateGate`, `AppConfigRepository`,
  `ApiModule` (Hilt). `data/auth`: `SessionStore` (+ `SealedSessionFile`), `InstallId`,
  `AuthRepository`, `SessionState` / `Session` / `SignOutReason`, `AuthModule` (`@SessionPreferences`
  DataStore `session`, `DeviceInfoSource`). `feature/login`: `LoginScreen` / `LoginRoute`,
  `LoginViewModel`, `LoginUiState` / `LoginMessage`, `LoginTags`, `OfficeDialer`, `SessionGate`.
  `feature/update`: `UpdateScreen` / `UpdateRoute`, `PlayStore`.

**How later tasks use it (T-064, T-065, T-066, T-069, T-070, T-071)**

- Calling the API: inject `MobileApi` and `ApiErrorParser`; `when (val r = apiCall(errors) {
  mobileApi.syncCustomers(cursor) }) { is ApiResult.Success -> r.value; is ApiResult.Failure -> r.failure }`.
  The client already sends `x-app-version-code`, the bearer token, refreshes on UNAUTHENTICATED (one
  refresh for any number of concurrent 401s) and retries once. Request bodies are replayable, so the
  retry resends the same payment batch (idempotent ids).
- `ApiFailure`: `Offline` (no answer; may or may not have reached the server), `Server(httpStatus,
  code: String, error)` with `knownCode`, `isTemporary` (429/5xx) and `retryAfterSeconds`, `AppTooOld`
  (update screen already showing), `SignedOut(reason)` (login screen already showing), `Malformed`
  (2xx body not matching the DTO). Queues (T-066/T-069): keep the item and retry later for `Offline`,
  `Malformed`, temporary `Server`, `AppTooOld` and `SignedOut`; never drop payments (BR-11). Unknown
  codes: go by `httpStatus` (contract README).
- Session: inject `AuthRepository` (`state: StateFlow<SessionState>`, `signIn`, `signOut()`) or
  `SessionStore` (`session: Session?` = `user`, `operator`, `device`). Payment fields:
  `collector_id = session.user.id`, `device_id = session.device.id`, provisional ref prefix
  `session.device.deviceCode`, collector name on receipts `session.user.name`, receipt footer and
  office phone `session.operator`.
- Logout (T-071): `authRepository.signOut()` clears the local session at once, then best-effort
  `POST /auth/logout`. It does not touch queued payments: T-071 warns before calling it while payments
  wait (PLAN §9.2).
- `/app/config`: `AppConfigRepository.refresh()` (T-064: call it after each sync). It updates the
  `UpdateGate`, the operator in the session, `config`, `tenantMode`, `isFeatureOn(name)`. SessionGate
  already calls it whenever someone becomes signed in.
- Force update: `UpdateGate.state` (`updateRequired`). Fed by `/app/config` (authoritative, can lower
  the minimum) and by any 426 APP_TOO_OLD (raises it); the last minimum is persisted, so the update
  screen also shows after a restart offline. Installing the update opens it by itself.
- UI: `MainActivity` now renders `SessionGate { CableApp() }`: update screen > blank while loading >
  login > app (keyed by user id, so another lineman starts with fresh screens). The login and update
  screens sit outside the shell's Scaffold and apply `safeDrawingPadding`.

**Decisions**

1. **Own small generator instead of openapi-generator.** The contract uses OpenAPI 3.1 nullability
   (`anyOf [$ref, {type: null}]`), `const`, unformatted integers up to 2^53 and one open enum;
   openapi-generator's Kotlin output needs type mappings, normalizer flags and supporting classes for
   each of these. The generator (~250 lines, refuses unknown shapes) is checked by the drift test and
   by decoding **all 42 fixtures**.
2. **DTOs committed** (like Tokens.kt and strings), so reviewers see DTO changes next to contract
   changes and the app builds without Node.
3. **Reactive refresh only** (on 401), not early from `access_token_expires_at`: a phone with a wrong
   clock would otherwise refresh before every request. Cost: one extra round trip per ~15 minutes.
4. **Single flight** = one JVM lock in `TokenRefresher`; callers pass the tokens their request used,
   and a caller that finds them already replaced reuses the new pair. Refresh refused with 401/403 ends
   the session (`REFRESH_TOKEN_INVALID` → `SESSION_EXPIRED`, `DEVICE_REVOKED` → `PHONE_SIGNED_OUT`,
   `ACCOUNT_DISABLED`/`ROLE_NOT_ALLOWED` → `ACCOUNT_DISABLED`, unknown → `SESSION_EXPIRED`); no internet,
   429 and 5xx keep the session. A late refresh result never signs out a newer session
   (`end(reason, onlyIfTokens)`).
5. **Session storage**: one JSON blob (tokens, user, operator, device) sealed with the existing Tink
   `Aead` (associated data `cb.session.v1`), base64 in a separate DataStore `session`; every change
   rewrites the whole blob in one DataStore transaction (atomic refresh-token rotation). If the
   Keystore fails, the session lives in memory only and the error goes to Sentry; an undecryptable blob
   is dropped (`STORAGE_RESET`, login asks again). `install_id` (random UUID v4), the last office phone
   and the last minimum version are plain entries in the same DataStore and survive sign-out.
6. **Login screen**: login field starts on digits (usually a mobile number), password on letters; each
   field has its own `123`/`ABC` toggle (it shows the keyboard you switch to). "Show password" is on by
   default. Sign-in is the green `BigButton` (Success) with the → icon. "Forgot password?" + a secondary
   "Call office" button opens the dialer (ACTION_DIAL, no permission) with the last known office
   number, or an empty dialer on a phone that never signed in (the operator is unknown before the first
   login). Messages: wrong password, account switched off, not a lineman, too many tries, no internet,
   something went wrong, and why a session ended ("Payments saved on this phone are safe").
7. Update screen: one job, one button ("Update app" → `market://details?id=<package>`, falling back to
   the Play web page), sentence: payments saved on the phone are safe and go to the office after the
   update.

**Deviations / changes outside the owned paths**

- `di/NetworkModule.kt` (T-008): the plain client now takes `AppVersionInterceptor`.
- `MainActivity.kt` (T-008): `SessionGate { CableApp() }` (one line). `MainActivityTest` now expects the
  login screen at start (bottom bar still covered by `CableAppNavigationTest`); T-067's
  `AppWithoutTtsTest` types into the login field instead of tapping the Today tab.
- `packages/design-tokens/icons.json` (T-003, done): new meanings `password` (lock), `show` (eye),
  `hide` (eye-off), regenerated `ic_cb_password/show/hide.xml` and `packages/ui/src/icons/icons.generated.ts`.
- `packages/i18n/glossary.md`: Sign in, Sign out, Show/Hide, Update app, User name, Password, Account.
- `libs.versions.toml`: `okhttp-mockwebserver3` (test only). `app/build.gradle.kts`: one test dependency
  line and an appended block (contract files as test inputs, `-Pcb.writeApiModels`).
- `apps/android/README.md`: API / sign-in section and layout lines.
- Update screen strings live in `mobile_login` (`update.*`) to stay inside the owned namespace.

**Follow-ups (no task files created)**

- T-028 (server): a refresh whose response is lost leaves the phone with an already-used refresh
  token → REFRESH_TOKEN_INVALID → sign-in again. Consider a short reuse grace window for the previous
  refresh token of the same `install_id`.
- `UserInfo.language` is not applied to the app language at login (T-071 owns the language setting).
- Product: what "Call office" should dial on a never-signed-in phone (today: empty dialer).
- Hindi review (H-03): `mobile_login` `_review` (22 keys) and the new glossary rows.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL; 90 app JVM tests, 0 failures (new: `ApiModelsUpToDateTest` 4, `ContractFixturesTest` 5,
  `AuthRepositoryTest` 9, `TokenRefreshTest` 10, `LoginScreenTest` 8, `SessionGateTest` 3); lint 0
  errors (2 existing warnings). `:app:assembleProdRelease` (R8) also builds.
- MockWebServer tests (Robolectric) use the fixtures as bodies: login request body equals
  `login.request.json` (with this install's id), refresh body, logout body, `x-app-version-code` on
  every request (login, refresh, config, logout), 401 → one refresh → retry with
  `example-access-token-2`, **5 concurrent 401s → exactly 1 refresh** (checked non-vacuous: without the
  single-flight check the test sees 5 refreshes), refused refresh → all waiting calls `SignedOut` + one
  refresh, DEVICE_REVOKED / ACCOUNT_DISABLED reasons, offline/500 refresh keeps the session, second 401
  not retried, `payments:batch` path and replayed body, APP_TOO_OLD on login and on a bearer endpoint
  opens the gate (persisted across restart), `/app/config` normal / read-only / lowered minimum, session
  survives restart and is not readable on disk, undecryptable blob → `STORAGE_RESET`, install id stable.
- Compose UI (Robolectric, Hindi): words, show password on by default (field shows the text; bullets
  after "छिपाएँ"), 123/ABC toggles, sign-in enabled only with both fields, all tappables ≥ 56dp and
  sign-in ≥ 64dp, real sign-in through the ViewModel, wrong-password message, "phone signed out by the
  office" message, Call office dials `tel:9800000001`; gate order (loading → login → app; update wins).
- The drift check fails for real: after changing the generator's KDoc output, the test reported the
  stale file until regenerated.
- `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm generate` (no diff),
  `tokens:build --check`, `icons:build --check`, `i18n:check`, `i18n:build --check`,
  `openapi:build --check`, `node scripts/tasks.mjs check --local`: all pass.
- **Not verified on a device:** the login screen's look in Hindi on a real phone, the soft keyboard
  switching between number and text layouts when tapping 123/ABC while the field is focused, the Play
  Store opening, the Keystore-backed key on API 26 and 35+ phones, and R8 release behaviour at runtime.

## Board log

- 2026-10-13T11:55:28.078Z claimed by agent-t063
- 2026-10-13T12:36:24.967Z completed on task/T-063-android-networking-auth-login-and-force
