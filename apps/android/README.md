# Cable Billing lineman app (Android)

Kotlin + Jetpack Compose app for linemen (PLAN §11). Package `com.cablebilling.lineman`
(provisional, D-21 / H-02). minSdk 26, targetSdk 36, compileSdk 37.

## Requirements

- **JDK 17 or newer** to build (Gradle 9.8 and AGP 9.4 run on 17+). The unit tests run Robolectric
  at API 36, whose Android runtime needs **JDK 21**; use JDK 21 for `test*UnitTest` (Android Studio's
  bundled JDK is fine).
- **Android SDK** with platform `android-37` and build-tools 36 (AGP downloads missing ones by itself
  when the SDK licences are accepted: `sdkmanager --licenses`). Point Gradle at the SDK with
  `ANDROID_HOME` or `sdk.dir` in `local.properties`.
- No Node.js: the generated files (tokens, icons, strings) are committed.

## Commands

Run from `apps/android`:

```bash
./gradlew assembleDevDebug           # debug APK for the dev flavour
./gradlew testDevDebugUnitTest       # JVM + Robolectric tests (incl. Compose UI tests)
./gradlew ktlintCheck detekt lint    # style, static analysis, Android lint
./gradlew ktlintFormat               # fix ktlint issues
./gradlew :detekt-rules:test         # tests for the project's own detekt rules
```

The full local check (same as tasks/README.md §3.5):
`./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug`.

## Flavours

| Flavour | applicationId | API base URL (BuildConfig.API_BASE_URL) |
|---|---|---|
| `dev` | `com.cablebilling.lineman.dev` | `http://10.0.2.2:3000/api/mobile/v1/` (local Next.js via the emulator; cleartext allowed only for 10.0.2.2 / localhost) |
| `staging` | `com.cablebilling.lineman.staging` | `https://staging.cablebilling.example/api/mobile/v1/` (placeholder until H-02) |
| `prod` | `com.cablebilling.lineman` | `https://app.cablebilling.example/api/mobile/v1/` (placeholder until H-02) |

Override a URL with `-Pcb.apiBaseUrl.<flavour>=…` (e.g. a phone on the same Wi-Fi as your laptop).
Sentry is off unless a DSN is given with `-Pcb.sentryDsn=…` or `SENTRY_DSN`.

## Layout

```text
app/                      the app: feature packages under com.cablebilling.lineman
  feature/{login,update,search,today,queue,…}   one package per feature (PLAN §11.1)
  data/network            Retrofit services, interceptors, generated DTOs (data/network/generated)
  data/auth               session store (Tink-sealed), install id, sign in / out
  ui/                     app shell (CableApp: bottom bar + NavHost), navigation
  di/                     Hilt modules (network, storage)
  locale/                 AppLanguage (Hindi default, per-app language)
  diagnostics/            CrashReporting (Sentry)
  schemas/                Room exported schemas (committed; created by the first @Database)
core/designsystem/        GENERATED Tokens.kt + ic_cb_* icons, CableTheme, fonts, components
                          (component/), Rupees formatting (money/), Speaker (voice/)
app/src/debug/            debug-only component catalogue (second launcher icon "Components (test)")
detekt-rules/             project detekt rules (no raw Color(0x…) / .dp / .sp outside core/designsystem)
config/detekt, config/lint  shared static-analysis config
gradle/libs.versions.toml version catalog (append-only shared file)
```

Generated, never edited by hand: `core/designsystem/.../generated/Tokens.kt` (`pnpm tokens:build`),
`core/designsystem/src/main/res/drawable/ic_cb_*.xml` (icons), and
`app/src/main/res/values*/strings_generated.xml` (`pnpm i18n:build`).

## API, sign-in and force update (T-063)

- `app/.../data/network/generated/ApiModels.kt`: **generated** DTOs (kotlinx.serialization) from
  `packages/contracts/openapi.json`. Never edit it. The generator is plain Kotlin in the unit-test
  source set (`data/network/codegen/ApiModelGenerator.kt`); `ApiModelsUpToDateTest` fails when the
  file is stale. After a contract change:
  `./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true`.
- `MobileApi` (every bearer endpoint) and `AuthApi` (login, refresh, logout): Retrofit, written by
  hand against the contract. Wrap calls in `apiCall(errors) { … }` to get an `ApiResult`.
- Every request sends `x-app-version-code`; the authenticated client adds the bearer token and
  refreshes it once on UNAUTHENTICATED (single flight). The session (tokens, user, operator, device)
  is sealed with the Keystore-backed Tink key in the `session` DataStore.
- The network tests run against MockWebServer with the contract fixtures in
  `packages/contracts/fixtures` (no server needed); those files are inputs of the test task.

## Design-system components

`core/designsystem/.../component/` holds the low-literacy kit (BigButton, MethodButton, NumberPad,
AmountDisplay, StatusChip, CustomerRow, SyncBanner, ConfirmCard, ReceiptActionTile, SpeakButton,
VoiceToggle). Components take their words as parameters; screens pass `stringResource(...)`. Debug
builds have a catalogue of all of them in Hindi and English: open the "Components (test)" launcher
icon, or `adb shell am start -n com.cablebilling.lineman.dev/com.cablebilling.lineman.catalogue.ComponentCatalogueActivity`.
The module's own tests (`./gradlew :core:designsystem:testDebugUnitTest`) also run as part of
`testDevDebugUnitTest`.

## Fonts

`core/designsystem/src/main/res/font/`: Inter and Noto Sans Devanagari, Regular (400) and
SemiBold (600) static instances from Google Fonts, under the SIL Open Font License 1.1
(licence texts in `core/designsystem/src/main/assets/licenses/`, shipped in the APK).
