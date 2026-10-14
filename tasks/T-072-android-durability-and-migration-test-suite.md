---
id: T-072
title: Android: durability and migration test suite
phase: 3
area: qa
status: done
owner: agent-t072
claimed_at: 2026-10-14T08:08:23.603Z
branch: task/T-072-android-durability-and-migration-test-su
depends_on: [T-066]
review: self
claimable_by: agent
size: M
paths: [apps/android/app/src/androidTest/**, apps/android/app/src/test/java/com/cablebilling/lineman/durability/**, docs/testing/android-field-uat.md]
---

# T-072 — Android: durability and migration test suite

**Phase** 3 · **Area** qa · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-066

## Goal

Automated proof of the offline guarantees, plus the manual field UAT script.

## Scope

- Instrumented tests: process death after save, device reboot simulation (WorkManager test driver), airplane mode day, duplicate retry.
- Room migration tests from schema v1.
- `docs/testing/android-field-uat.md` step-by-step script for humans (H-04/H-05).

## Acceptance criteria

- [ ] Suite runs in CI on an emulator (or documented as nightly if too slow). **Partly met, left
  unticked:** every scenario runs in CI on **every PR on Robolectric** (it is part of `testDevDebugUnitTest`),
  and the instrumented APK builds (`assembleDevDebugAndroidTest`). The emulator run is **documented as a
  nightly + manual job** (ready-to-paste workflow in `docs/testing/android-field-uat.md`), but the workflow
  file is not in this task's paths (tasks/README.md §6), so it is not added yet, and no emulator run has
  happened (no `/dev/kvm` in the build container). The coordinator adds the workflow (see Completion notes).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/androidTest/**`
- `apps/android/app/src/test/java/com/cablebilling/lineman/durability/**`
- `docs/testing/android-field-uat.md`

## References

PRD §15 #8–#11, PLAN §16 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What ran for real, and where.** All scenarios ran on **Robolectric** (JVM) in this container and pass.
The instrumented suite **compiles and packages** (`assembleDevDebugAndroidTest`) but has **never run on an
emulator or phone**: the container has no `/dev/kvm`. Robolectric runs the very same test classes (see
"one suite, two runners"), so the scenario logic is proven; what only a device can show (real SQLite and
its journal settings, Keystore, MockWebServer on Android, the runner) is unverified until the nightly job
or a developer's `connectedDevDebugAndroidTest` runs it.

**What exists**

- `apps/android/app/src/androidTest/shared/java/com/cablebilling/lineman/durability/` — **one suite, two
  runners**: compiled into the androidTest *and* the unit-test source sets (appended block in
  `app/build.gradle.kts`, via `kotlin.srcDir`: AGP 9's built-in Kotlin ignores extra `java` dirs). It runs
  on every PR inside `testDevDebugUnitTest` and on a device with `./gradlew connectedDevDebugAndroidTest`.
  - Support: `Phone` (a phone's private storage + the running app "process"; `kill()` closes the database
    and DataStore, cuts open calls and drops every in-memory object, `start()` cold-starts on the same
    files; on a device the session is sealed with a **real Android Keystore** key that must open it again
    after every restart; `loseKey()` simulates a Keystore reset), `PhoneProcess` (the production classes
    and the production Hilt module functions `NetworkModule` / `ApiModule`, DatabaseModule's builder),
    `FakeOffice` (MockWebServer dispatcher with T-046/T-061 semantics: idempotent on the payment id,
    `duplicate` with the first answer, `ID_REUSED_WITH_DIFFERENT_DATA` counted in `reusedIds`; faults:
    `airplaneMode`, `loseAnswers()` / `loseAnswersFromBatch`, `failNext` (503), `disabledLogins` (401 then
    403 ACCOUNT_DISABLED on refresh)), `PushWork` (WorkManager test driver: `networkBlip()` = one network
    window, `networkBack()` = until the queue is empty, `install()` again = the OS lost the jobs,
    `appStart()` = `PaymentSyncScheduler.start()` on the main thread), `DurabilityFixtures`, `TestClock`,
    `DurabilityTest` (base + `assertEverythingAtTheOfficeOnce`).
  - `ProcessDeathTest` (5): killed after the commit but before the push request → found and sent once at
    the next start, temporary number kept; killed with the push queued → WorkManager runs it in the next
    process; Save again on the restored Confirm screen → one payment; 8 kills × 3 saves → 24 payments, refs
    P-K7Q-0001…0024 with no repeat, all sent once; 120 payments, batch 2's answer lost after the office
    saved it, killed before the retry → 120 posted once, batch 2 resent with identical items.
  - `RebootTest` (3): push queued before a reboot runs after it in a process that only has the files (the
    sealed sign-in opens again); three reboots while the office is unreachable (network up, no internet)
    → nothing sent, nothing lost, still queued, then sent once; the OS lost the scheduled job (force stop /
    OEM cleaner) → the next app start pushes.
  - `AirplaneModeDayTest` (1): 60 payments 09:08–17:00 IST, cash and UPI, network blips every 15, kills
    every 25 → nothing at the office during the day, Today's cash/UPI totals right, all on one business
    date; evening → each payment once, oldest first, batches [50, 10], no item sent twice.
  - `DuplicateRetryTest` (3): lost answer → resend with byte-identical items, counted once; lost answers +
    503s + kills ×3 → one payment, every item the office read identical; concurrent double tap on Save →
    one row, one temporary number, one payment at the office.
  - `SharedPhoneTest` (2): two linemen on one phone with a **switched-off lineman** (push → 401 → refresh →
    403 ACCOUNT_DISABLED → session ends, payments stay) → the other lineman's payment goes, the first
    lineman's stay held across restarts and go once, under the right `collector_id`, when he signs in
    again; **Keystore loses its key** → STORAGE_RESET sign-in, payments still there and sent after sign-in.
  - `RoomMigrationSuiteTest` (4, `MigrationTestHelper`): every schema version is packaged in the test APK,
    has a seed (`MigrationSeeds`) and a migration step; the current code creates exactly the newest
    committed schema (identity hash of a fresh database = committed JSON); **a v1 database with rows in
    every table** (customers, VCs, open bills, payments in all states incl. a held one, receipt outbox,
    collection day with `handover_json` and `queued_handover_json`, sync_meta) is migrated to the current
    version, validated, and read back with today's DAOs and JSON classes (projected due, ref sequence,
    `oldestSendable`, `QueuedHandover`, `Handover`, allocations); each step N-1 → N on its own.
  - `DatabaseSafetyTest` (2): the real `DatabaseModule.provideDatabase` refuses a database written by a
    newer app version (IllegalStateException) and the payment stays in the file — no destructive fallback;
    `PRAGMA journal_mode` / `synchronous` logged (`adb logcat -s CableDurability`) and `synchronous` must not
    be OFF — **on a device only** (skipped on Robolectric, whose SQLite runs with `synchronous=0`). On a
    device it runs only if the app's own `cable.db` does not exist and deletes it afterwards.
- `apps/android/app/src/androidTest/java/com/cablebilling/lineman/durability/DurabilityTestRunner.kt` —
  `testInstrumentationRunner`: AndroidJUnitRunner with a plain `Application`, so `CableApplication` (Hilt,
  Sentry, the real schedulers against the app's own database/session/WorkManager) never starts in
  instrumented runs.
- `apps/android/app/src/test/java/com/cablebilling/lineman/durability/FieldDayOfflineTest.kt` (2,
  Robolectric only: it uses the contract fixtures and the T-066/T-069/T-070 fakes) — morning roster pull →
  airplane mode → search still answers → 3 payments, print results recorded, cash handover saved offline →
  two kills → evening: payments first, the handover (office's expected cash already counts them, no
  discrepancy), then receipt actions; each exactly once, and a second evening run sends nothing.
  Receipt actions survive kills and a lost answer → recorded once.
- `docs/testing/android-field-uat.md` — the step-by-step field script for H-04/H-05 (sections A–N: sign-in
  and Hindi at 360 × 640 with large fonts, observed low-literacy tasks, swipe-away / force stop / `am kill`
  after Save, reboot, airplane-mode day, power cut, battery savers and Doze, lost answers, real 58 mm
  printers and their failures, WhatsApp/SMS/PDF honest words, two linemen on one phone, deactivated
  lineman, cash handover, app update over an old build), reporting rules, how to run the instrumented suite
  and the proposed CI workflow.

**How to run the instrumented suite**

```bash
cd apps/android
./gradlew connectedDevDebugAndroidTest   # emulator or phone with USB debugging
./gradlew connectedDevDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.package=com.cablebilling.lineman.durability
adb logcat -d -s CableDurability         # the device's SQLite journal settings
```

**Proposed emulator CI job (not added: `.github/workflows/**` is not a §6 shared path).** A new
`.github/workflows/android-device-tests.yml`, nightly (`cron: "40 21 * * *"` = 03:10 IST) plus
`workflow_dispatch`, matrix API 26 and 35, `reactivecircus/android-emulator-runner` (google_apis,
x86_64, KVM enabled through the udev rule), `./gradlew connectedDevDebugAndroidTest`, uploading
`app/build/reports/androidTests/` and `outputs/androidTest-results/`. Full YAML in
`docs/testing/android-field-uat.md` ("Proposed CI job"); actions must be pinned to SHAs like `android.yml`.
Nightly rather than per PR because an emulator boot + run is ~10–15 min per API level and the same
scenarios already run per PR on Robolectric. Alternative: Gradle Managed Devices (needs a build block).

**Decisions**

1. **One suite, two runners** instead of separate instrumented and Robolectric copies: the Robolectric run
   on every PR proves the instrumented tests' logic, and nothing drifts. Cost: the shared folder may only
   use what both classpaths have, and test names must not contain spaces (DEX on API 26).
2. **Process death is simulated in-process** (close Room/DataStore, cancel calls, new objects on the same
   files), as in T-066. A real kill of the instrumentation process would kill the test. Real kills, reboots
   and power cuts are in the UAT script (C–F).
3. **Reboot = WorkManager's queue survives, the process does not** (the test WorkManager is a singleton
   outside the "process"), plus the worst case where the OS lost the job (`install()` again → app start).
4. **Lost answers are sticky** (`loseAnswers()` until `answerAgain()`): OkHttp silently resends a POST
   whose reused connection broke, so a one-shot drop is often invisible to the app (found while writing the
   120-payment test). Assertions accept OkHttp's extra resend (the office sees duplicates, never a second
   payment).
5. **Migration "pattern for every future version":** `MigrationSeeds.byVersion` must have an entry per
   exported version and the suite fails otherwise; the seed writes raw SQL in that version's columns and the
   checks read with the current code, including the JSON columns Room's schema validation cannot see.
6. The roster pull, receipt sync and handover are not driven through WorkManager in the shared suite (their
   workers are covered by T-064/T-069/T-070's tests); the Robolectric field day runs them in the workers'
   order.

**Deviations / files outside the owned paths**

- `apps/android/app/build.gradle.kts` (§6 shared): `testInstrumentationRunner` → `DurabilityTestRunner`
  (one line changed), six `androidTestImplementation` lines, and an appended `android { sourceSets { … } }`
  block adding `src/androidTest/shared/java` to both test source sets.
- `apps/android/gradle/libs.versions.toml` (§6 shared): `androidx-test-runner` 1.7.0.
- `apps/android/README.md`: a "Durability and migration suite (T-072)" section (like earlier tasks did).
- No production code changed.

**Open questions / follow-ups**

- **Coordinator:** add the nightly emulator workflow above (and decide whether `assembleDevDebugAndroidTest`
  should join the PR job's Gradle line: today the PR job compiles the shared folder through the unit tests,
  but `DurabilityTestRunner` and the androidTest dependency set are compiled only by
  `assembleDevDebugAndroidTest` — Android lint analyses those sources without compiling them).
- **Power cut:** if a device logs `journal_mode=wal synchronous=1`, the last commits can be lost on a power
  cut (not on a crash); T-064's follow-up (set `synchronous=FULL` on the write connection, or
  `JournalMode.TRUNCATE`) would then be needed. Only a device run can tell.
- A future Hilt/Compose instrumented test needs a Hilt runner; it can replace `DurabilityTestRunner` and keep
  a plain application for the durability package (note in the runner's KDoc).
- The switched-off lineman's held payments still need the office "release" flow proposed in T-066.
- A mutation check (making Save non-idempotent, or adding a destructive fallback) was not run: the agent
  sandbox refused edits to production code for that purpose. Worth doing by hand once.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2, Postgres 17; no emulator)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug assembleDevDebugAndroidTest
  :detekt-rules:test` (rebased on `feature/mvp` 985fd0e): BUILD SUCCESSFUL. App JVM tests 377, 0 failures,
  1 skipped (the SQLite-settings check, device only); 22 of them are this task's (20 shared + 2
  Robolectric-only). `app-dev-debug-androidTest.apk` is built. The durability package was also re-run twice
  more with `--rerun` (green). One order-dependent assertion found that way (two receipt actions recorded in
  the same millisecond come back in random-id order) was fixed to compare as a set.
- **Not run:** `connectedDevDebugAndroidTest` (no emulator/KVM here). Nothing in this task has run on a device.
- Root (after the final rebase on `feature/mvp` 1d0820c, whose new commits touch no Android input):
  `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (10/10 incl. DB tests on
  Postgres 17), `pnpm build`, `pnpm generate` (no diff), `node scripts/tasks.mjs check --local`: all pass.
  The first `pnpm test` hit a 30 s timeout in `@cb/core` `auth.test.ts` ("password reset … single-use link",
  42 s on a machine shared with other agents' builds); unrelated to this task (no TypeScript changed), it
  passed on the re-run.

## Board log

- 2026-10-14T08:08:23.603Z claimed by agent-t072
- 2026-10-14T12:42:03.672Z completed on task/T-072-android-durability-and-migration-test-su
