---
id: T-071
title: Android: settings, diagnostics and crash reporting
phase: 3
area: android
status: done
owner: agent-t071
claimed_at: 2026-10-13T16:18:48.674Z
branch: task/T-071-android-settings-diagnostics-and-crash-r
depends_on: [T-063, T-067, T-068]
review: self
claimable_by: agent
size: S
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/feature/settings/**, apps/android/app/src/main/java/com/cablebilling/lineman/diagnostics/**, packages/i18n/messages/*/mobile_settings.json]
---

# T-071 — Android: settings, diagnostics and crash reporting

**Phase** 3 · **Area** android · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-063, T-067, T-068

## Goal

Low-traffic settings kept out of the lineman's way.

## Scope

- Language हिंदी/English, voice on/off, printer setup entry, sign out (blocked while unsynced payments exist, with explanation), app version.
- Local diagnostic log (no PII) + 'Send diagnostics' share; Sentry init with flavour DSN.

## Acceptance criteria

- [x] Sign-out never deletes queued payments.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/feature/settings/**`
- `apps/android/app/src/main/java/com/cablebilling/lineman/diagnostics/**`
- `packages/i18n/messages/*/mobile_settings.json`

## References

PLAN §11.3 (Settings), PLAN §11.1 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**Acceptance criterion** (sign-out never deletes queued payments): met in the JVM tests (Robolectric, real
Room queue, session store, push and logout call against MockWebServer). It was not checked on a phone
(no emulator here). A mutation check made the guard always return "no payments": both
`SignOutKeepsPaymentsTest` cases then failed, so the guard is what the tests rely on.

**What exists** (`apps/android/app/src/main/java/com/cablebilling/lineman/…`; overview in `apps/android/README.md`)

- `feature/settings/`: `SettingsRoute` + `Settings(onBack, onPrinterSetup, onOpenWaiting)` (Hilt) /
  `SettingsContent(state, …)`, `SettingsViewModel` (`SettingsUiState`, `SignOutStep` Idle → Checking →
  Confirm | Blocked → SigningOut), `SettingsData` / `AppSettingsData` / `PushNow`, `SettingsButton` (the
  gear), `SettingsTags`.
  - Language: two big buttons, "हिंदी" and "English", each always in its own script; the current one is
    filled with a tick. `AppLanguage.set` changes the whole app (per-app language API, stored by AppCompat
    below API 33 and by the system on API 33+). The activity is recreated and the back stack restored,
    so the lineman stays on Settings.
  - Voice: the design-system `VoiceToggle` on the shared `Speaker` (T-067 stores it as `voice_muted`).
  - Printer: the saved printer's name (T-068 `PrinterSettings`) or "No printer yet", plus "Set up
    printer" → `PrinterSetupRoute`.
  - Sign out: "Signed in: <name>" (the lineman's own name, shown only on screen), then "Sign out". The
    check is `PaymentDao.oldestSavedOnPhoneFor(userId, 1)`, as T-066 asked. If this lineman has payments
    on the phone, a card says "You cannot sign out yet", how many are still on the phone (a live count),
    "The payments are safe. Signing out never deletes them.", and offers **Try now**
    (`PaymentSyncScheduler.tryNow`), **Open Waiting** (switches to the Waiting tab) and Cancel. When the
    count reaches 0 it says "All your payments reached the office. You can sign out now." Otherwise:
    "Sign out of this phone?" → "Yes, sign out", which checks again, then `AuthRepository.signOut()`.
    SessionGate then shows the login screen. Another lineman's held payments and refused
    (`NEEDS_OFFICE_HELP`) ones do not block sign-out; they stay on the phone.
  - App version (`0.1.0-dev (1)`) and "Share app report".
- `diagnostics/`:
  - `DiagnosticLog`: a ring buffer on disk in `noBackupFilesDir/diagnostics`, with a 64 KiB cap. It uses
    two files: `current.log` rolls over into `previous.log` at half the cap. Writes happen on one
    background thread; `crash()` writes synchronously. Lines look like
    `2026-10-13T11:30:00.000Z I payment_push status=no_internet`. API: `info/warn(event, detail)`,
    `error(event, throwable)`, `crash(throwable)`, `lines()`, `flush()`. The event must be a
    `snake_case` code (anything else becomes `event`). Every detail goes through `PiiScrubber`, and lines
    are capped at 400 characters (2,000 for errors). Exceptions are written as class names and the top 8
    frames of up to 3 causes. Their **messages are never written**, because they are free text.
  - `PiiScrubber`: removes bearer tokens and JWTs; long letter+digit strings (refresh tokens, UUIDs);
    values of fields whose name contains name, phone, mobile, login, password, token, secret, amount,
    paise, rupee, address, email, upi, customer, collector, receipt, reference or dsn; e-mail addresses;
    URL query strings; ₹ / Rs / INR amounts; runs of 6 or more digits (phone, VC, paise); and Devanagari
    text. Counts, HTTP statuses and line numbers stay.
  - `DiagnosticsRecorder` (started in `CableApplication`): logs `app_start` (version, flavour, sdk);
    `session signed_in` / `signed_out reason=…`; `payment_push status=running|finished|no_internet|failed`;
    and crashes. For crashes it installs a default uncaught-exception handler that writes the crash line
    and then calls the previous handler (Sentry's, then Android's). Settings adds `sign_out`,
    `sign_out_blocked`, `sign_out_try_now`, `language app=en` and `report`.
  - `DiagnosticReport` + `AppInfo` + `QueueCounts`: the plain-text report and the share intent
    (`ACTION_SEND` text/plain inside `createChooser`). The report has the version and flavour, Android
    release and SDK, manufacturer and model, app language, queue counts (waiting / needs_help /
    other_lineman), then the log lines. The UI says "Share app report", never "sent".
  - `CrashReporting.init(context, dsn, environment, release)`: starts Sentry only when `shouldStart(dsn,
    Build.FINGERPRINT)`: a DSN is set and the device is not Robolectric. `configure(options, …)` sets
    `sendDefaultPii = false`, no screenshots and no view hierarchy (both would show names and amounts),
    no tracing, release `lineman@<versionName>+<versionCode>`, environment = flavour, and the
    `beforeSend` / `beforeBreadcrumb` hooks from `SentryPrivacy`.
  - `SentryPrivacy.scrub(event)`: removes the request, the server name and the device name. From the user
    it keeps only Sentry's random install id. It scrubs the message, its params, exception values,
    breadcrumbs (message and data), extras and tags. `scrub(breadcrumb)` scrubs a breadcrumb.
- **Per-flavour DSN** (`app/build.gradle.kts`): `BuildConfig.SENTRY_DSN` per flavour comes from
  `-Pcb.sentryDsn.<flavour>` or `SENTRY_DSN_<FLAVOUR>`. Staging and prod fall back to the shared
  `-Pcb.sentryDsn` / `SENTRY_DSN`; dev never does, so local builds and the devDebug unit tests have
  none.
- Strings: namespace `mobile_settings` (24 keys, all Hindi in `_review`). Glossary: new "Settings words"
  table. Icon: new meaning `share` (Lucide `share-2`) → `ic_cb_share`.

**Decisions (please check)**

1. **Where Settings lives:** a small, muted gear (56dp tap area) at the end of the search home's digit
   row. It is visible but "less prominent" (PLAN §11.3), costs no screen height, and is gone while the
   phone keyboard is open. I did not use a long-press, because illiterate users would never find it. I
   did not add a 4th bottom-bar tab, because PLAN §11.2 fixes three. Settings sits on the Search tab's
   stack, so the Search tab stays highlighted. Language is two taps from home, not one (PLAN §2.2 rule 10
   asks for one tap). If field tests ask for one tap, put a language button on the home.
2. **Sign-out is blocked only by this lineman's `SAVED_ON_PHONE` payments.** A refused payment
   (`NEEDS_OFFICE_HELP`) would never leave, so it would block sign-out forever. Another lineman's held
   payments are not this lineman's to send. Both stay on the phone untouched.
3. **The check runs twice:** when "Sign out" is tapped and again at "Yes". A payment saved in between
   blocks it. No new DAO query was added: the live count filters `observeNotSent()`.
4. **Exception messages are kept out of the shared log entirely.** Sentry does get scrubbed exception
   values, because without them crashes are hard to debug. Residual risk: a Latin-script name inside a
   free-text exception message, for example `NumberFormatException: For input string: "Ramesh"`, is not
   recognised by the scrubber. The app's own code does not put customer data in exception messages.
   Product owner: say if Sentry should drop exception values entirely.
5. The report has no ids at all: no install id, user id or device code. Support identifies the phone from
   whoever shared it. If support needs a device code to match server logs, the `device_code` (P-ref
   prefix) could be added.
6. The log uses `noBackupFilesDir`, and the app already has `allowBackup=false`.

**Deviations / files outside the owned paths** (all small)

- `ui/CableApp.kt` (§6 route wiring): `SettingsRoute` destination, `settingsScreen` slot (Hilt default),
  the default `searchHome` passes `onOpenSettings`, and `SettingsRoute` is added to the Search tab's
  sub-screens.
- `feature/search/SearchScreen.kt` (T-065, done): optional `onOpenSettings` on `SearchScreen` /
  `SearchContent`. The gear sits at the end of the digit row and the query text got `weight(1f)`. With
  no callback there is no gear, so existing tests are unchanged.
- `CableApplication.kt`: `AppInfo` + `DiagnosticsRecorder` injected; `CrashReporting.init(…, release)` and
  `diagnostics.start()`.
- `app/build.gradle.kts`: the per-flavour `SENTRY_DSN` replaces the single `defaultConfig` field.
- `packages/design-tokens/icons.json` (T-003, done): `share` → regenerated `ic_cb_share.xml` and
  `packages/ui/src/icons/icons.generated.ts`.
- `docs/runbooks/environments.md` §4.3 step 5: Android DSN secret names. `apps/android/README.md`,
  `packages/i18n/glossary.md`.
- No new dependencies: `sentry-android-core` was already in the catalog (T-008).

**Open questions / human steps**

- **Sentry DSN provisioning (H-01):** create the `cable-billing-android` project and put its DSN in the
  CI secrets `SENTRY_DSN_PROD` (and `SENTRY_DSN_STAGING`). The release workflow (T-073) must pass them to
  Gradle. Until then every build has Sentry off.
- Optional, for T-073: upload R8 mapping files to Sentry (the Sentry Gradle plugin) so release stack
  traces are readable.
- Lint's existing `AppBundleLocaleChanges` warning matters more now that the language switch is live:
  set `bundle { language { enableSplit = false } }` before the first Play upload (already noted for
  T-067 / T-073).
- Hindi review (H-03): `mobile_settings` `_review` (24 keys) and the new glossary rows.

**Verification** (JDK 21, Android SDK, Node 24.21.0, pnpm 12.11.2, Postgres 17; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`: BUILD
  SUCCESSFUL. 283 JVM tests, 0 failures. Lint: 0 errors, 2 existing warnings.
- New tests (33): `PiiScrubberTest` (5), `DiagnosticLogTest` (7: format, size cap with the newest lines
  kept, survives restart, no personal data on disk including from exceptions, bad event names and long
  lines, a synchronous crash line, recorder events), `CrashReportingTest` (5: starts only with a DSN and
  never under Robolectric, dev has no DSN, options, `beforeSend` / `beforeBreadcrumb` scrubbing of every
  event field, report + share intent), `SettingsViewModelTest` (7), `SignOutKeepsPaymentsTest` (2: blocked
  → Try now → push → confirm → signed out + logout call, with every row unchanged including another
  lineman's held and a refused one, then the other lineman signs in and his payments are pushed; and a
  sign-out that skips the check deletes nothing), `SettingsScreenTest` (7, Compose in Hindi: words,
  language selection, voice toggle, printer, blocked → Try now / Open Waiting → possible → confirm, cancel,
  share sheet chooser with the report text, touch targets ≥ 56dp, the gear on the search home, the
  route on the Search tab → Waiting tab).
- `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (incl. DB tests), `pnpm build`, and
  `pnpm generate` (no diff) all pass. So do `tokens:build --check`, `icons:build --check`,
  `i18n:build --check`, `i18n:check`, `openapi:build --check` and `node scripts/tasks.mjs check --local`.
- **Still needs a real phone:**
  - Switching हिंदी ↔ English on API 26 (AppCompat storage, activity recreate) and on API 33+ (system
    per-app language), and that the choice survives an app restart.
  - The share sheet with WhatsApp.
  - A real crash reaching Sentry with a test DSN (scrubbed, no screenshot), and the crash line in the
    report after a restart.
  - How the gear looks on the home in Hindi on a small screen.

## Board log

- 2026-10-13T16:18:48.674Z claimed by agent-t071
- 2026-10-13T19:18:38.538Z completed on task/T-071-android-settings-diagnostics-and-crash-r
