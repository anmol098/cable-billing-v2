---
id: T-008
title: Android project scaffold
phase: 0
area: android
status: done
owner: agent-t008
claimed_at: 2026-10-13T05:36:18.925Z
branch: task/T-008-android-project-scaffold
depends_on: [T-002, T-004]
review: self
claimable_by: agent
size: L
paths: [apps/android/**]
---

# T-008 — Android project scaffold

**Phase** 0 · **Area** android · **Size** L · **Review** self · **Claimable by** agent · **Depends on** T-002, T-004

## Goal

Buildable Kotlin/Compose app skeleton with the module layout, flavours and libraries from the plan.

## Scope

- Gradle Kotlin DSL + version catalog; modules `app` and `core/designsystem` (consumes generated Tokens.kt, icons, strings).
- applicationId `com.cablebilling.lineman` (provisional, D-21), minSdk 26, targetSdk = latest Play requirement, flavours `dev` / `staging` / `prod` with API base URL per flavour.
- Hilt, Compose (Material 3) + Navigation Compose, Room (schema export dir), WorkManager (Hilt worker factory), Retrofit + OkHttp + kotlinx.serialization, DataStore, Tink, Sentry (no-op without DSN), Coroutines.
- Bundled fonts (Inter + Noto Sans Devanagari); `CableTheme` mapping tokens onto MaterialTheme + `LocalSemanticColors`.
- App shell: bottom bar with 3 destinations (Search, Today, Waiting) as placeholder screens; default locale Hindi with in-app language override (per-app language API).
- ktlint + detekt configured; detekt rule/forbidden-pattern for raw `Color(0x` and `.dp` literals outside `core/designsystem`.
- `./gradlew lint test assembleDevDebug` works.

## Acceptance criteria

- [x] Fresh clone builds with JDK 17+ and the Android SDK only (no Node needed).
- [ ] App launches on an API 26 emulator and an API 35+ emulator showing the bottom bar in Hindi.
  _Unverified: no /dev/kvm in the agent container, so no emulator could run. Robolectric covers it
  partly (see Completion notes). Needs a human or emulator CI check._

## Tests required

- One JVM unit test and one Compose UI test (bottom bar navigation).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/**`

## References

PLAN §11.1, PLAN §4, D-03, D-08, D-21 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (details and commands in `apps/android/README.md`)

- Gradle 9.8.0 wrapper (committed, `distributionSha256Sum` pinned), Kotlin DSL, version catalog
  `apps/android/gradle/libs.versions.toml`. Modules: `:app` (`com.cablebilling.lineman`),
  `:core:designsystem` (`com.cablebilling.designsystem`), `:detekt-rules` (JVM, lint tooling only).
- Versions (latest stable on Maven metadata, each released ≥ ~2 weeks before 2026-10-13): AGP 9.4.1,
  Kotlin 2.4.20 (2.4.21 was 5 days old), KSP 2.3.12, Compose BOM 2026.09.00 (Material 3), Navigation
  2.10.2, Hilt 2.60.1 + androidx.hilt 1.4.0, Room 2.8.5 (+ Room Gradle plugin), WorkManager 2.12.0,
  DataStore 1.2.1, Retrofit 3.0.0, OkHttp 5.5.0, kotlinx.serialization 1.11.0, coroutines 1.11.0,
  Tink 1.23.0, Sentry `sentry-android-core` 8.58.0, AppCompat 1.8.0, Robolectric 4.17, detekt 1.23.8,
  ktlint 1.8.0.
- SDK levels: minSdk 26, **targetSdk 36** (Google Play requires API 36 / Android 16 for new apps and
  updates since 31 Aug 2026), **compileSdk 37**: the current AndroidX/Compose/OkHttp releases declare
  `minCompileSdk 37` in their AAR metadata, so 36 does not build. compileSdk does not change runtime
  behaviour; AGP downloads `platforms;android-37.0` (and build-tools 36.0.0) itself.
- Flavours (dimension `env`): `dev` (`.dev` suffix, `http://10.0.2.2:3000/api/mobile/v1/`, cleartext
  only for 10.0.2.2/localhost via a dev-only network security config), `staging` (`.staging`),
  `prod`. `BuildConfig.API_BASE_URL` per flavour (staging/prod are `*.cablebilling.example`
  placeholders, TODO H-02); override with `-Pcb.apiBaseUrl.<flavour>=…`. `BuildConfig.SENTRY_DSN`
  from `-Pcb.sentryDsn` / `SENTRY_DSN`, empty by default. Release: R8 + resource shrinking
  (unsigned prod release APK is 2.4 MB).
- App: `CableApplication` (@HiltAndroidApp, `Configuration.Provider` with `HiltWorkerFactory`; the
  WorkManager startup initializer is removed in the manifest), `MainActivity` (AppCompatActivity,
  @AndroidEntryPoint, edge-to-edge, `CableTheme { CableApp() }`), `ui/CableApp` (Scaffold +
  NavigationBar + type-safe NavHost), `ui/navigation/TopLevelDestination` (Search, Today, Waiting with
  `ic_cb_search/today/waiting` from T-003 and `R.string.mobile_shell_nav_*`), placeholder screens in
  `feature/search`, `feature/today`, `feature/queue` (`ui/PlaceholderScreen`), `di/NetworkModule`
  (Json, OkHttpClient with BASIC logging in debug only, Retrofit on `API_BASE_URL`),
  `di/StorageModule` (DataStore `settings`, Tink `Aead` with keyset sealed by Keystore key
  `android-keystore://cb_master_key`; both lazy), `locale/AppLanguage`, `diagnostics/CrashReporting`.
- Design system: `theme/CableTheme.kt` (composable `CableTheme(language = …) {}` + `object CableTheme`
  accessors), `SemanticColors` + `LocalSemanticColors`, `NumericTypography` + `LocalNumericTypography`,
  `CableTypography` (M3 scale from `Tokens.Type`/`Tokens.Weight`, line height left to the font),
  `CableFonts`, `CableSpacing`. Fonts in `res/font`: Inter and Noto Sans Devanagari, 400 + 600 static
  TTFs from Google Fonts (~1.1 MB together), OFL texts in `src/main/assets/licenses/` (shipped).
- Language: Hindi default via the per-app language API. `res/xml/locales_config.xml` (hi, en) +
  `android:localeConfig`; `AppLocalesMetadataHolderService` with `autoStoreLocales` for API < 33.
- i18n: new namespace `packages/i18n/messages/{en,hi}/mobile_shell.json` (`nav_search`, `nav_today`,
  `nav_waiting`; Hindi from the glossary, flagged in `_review`).
- Lint/style: `./gradlew ktlintCheck` / `ktlintFormat` (ktlint CLI via JavaExec, `ktlint_official`
  style, `.editorconfig` in apps/android), `./gradlew detekt` (one root task over all modules, config
  `config/detekt/detekt.yml`, plus the `cable` rule set from `:detekt-rules`: `RawColorLiteral`
  (`Color(0x…)`, `ComposeColor(…)`, `Color(255, 0, 0)`) and `RawDimensionLiteral` (`16.dp`, `4.5.dp`,
  `18.sp`, `(-2).dp`), excluded only for `**/core/designsystem/**`). Android lint config
  `config/lint/lint.xml` (`abortOnError`; version-freshness checks off; `UnusedResources` ignored for
  the generated icon/string catalogues). Generated code (`**/generated/**`) is excluded from
  ktlint/detekt.

**Interfaces for T-009 and later Android tasks**

- Theme: wrap UI in `CableTheme { }`. Colours: `MaterialTheme.colorScheme.*` (every role maps to a
  token: primary = accent, background/surface = bg, surfaceVariant/surfaceContainer* = surface,
  outline = border, error = danger, secondaryContainer = border grey for selection) or
  `CableTheme.semanticColors.cash/upi/pending/success/danger/due/credit`. Type:
  `MaterialTheme.typography.*` (bodyLarge/bodyMedium = 18sp Base, labelLarge = 18sp strong,
  headlineLarge = Xxl, display* = Amount) and `CableTheme.numericTypography.amount/body` (Inter,
  tabular figures) for numbers. Shapes: `MaterialTheme.shapes` (Radius Sm/Md/Lg). Spacing:
  `CableSpacing.S1…S8` (= Tailwind `p-1…p-8`), sizes `Tokens.Size.TouchMin/PrimaryButton`.
  Body font follows the app language: Noto Sans Devanagari for `hi` (it has Latin and ₹ too), Inter
  for `en` (Compose cannot chain two bundled families per glyph).
- No `.dp`/`.sp`/`Color(…)` literals outside `core/designsystem`: detekt fails. Add new named sizes to
  `core/designsystem` (ideally as tokens in `tokens.json`).
- Strings: `R.string.<ns>_<key>` from `packages/i18n` (`common` + `mobile_*`). Add a namespace per
  feature (`mobile_login`, `mobile_settings` …), then `pnpm i18n:build`.
- Icons: `painterResource(com.cablebilling.designsystem.R.drawable.ic_cb_<name>)` (import the R as
  an alias, e.g. `import com.cablebilling.designsystem.R as DesignR`; R classes are non-transitive).
- Language: `AppLanguage.set("en"|"hi")`, `AppLanguage.current()` (T-071 settings).
- Navigation: add routes as `@Serializable` objects/classes; new top-level tabs go in
  `TopLevelDestination`, sub-screens as `composable<Route>` in `CableApp`'s NavHost (T-063 puts
  login in front of the shell).
- Network: inject `Retrofit` / `OkHttpClient` / `Json`; T-063 adds the auth interceptor (easiest: make
  `provideOkHttpClient` take interceptors) and Retrofit services. Storage: inject
  `DataStore<Preferences>` and `Aead`.
- WorkManager: annotate workers `@HiltWorker` with `@AssistedInject` constructors; they get injected
  automatically. Room: put `@Database` classes anywhere in `:app`; the KSP compiler and schema export
  to `app/schemas/` are wired (checked with a throwaway entity, which wrote `schemas/…/1.json`; not
  committed).
- Dependencies: add a `[versions]` entry and a `[libraries]` alias in `libs.versions.toml`
  (kebab-case keys → `libs.foo.bar`), prefer BOMs, then append one line in `app/build.gradle.kts`.
  AGP 9 built-in Kotlin: do not apply `org.jetbrains.kotlin.android`; use `ksp(…)` for processors.
- Tests: JVM unit tests and Robolectric/Compose UI tests live in `app/src/test` and run with
  `./gradlew testDevDebugUnitTest`. Use `androidx.compose.ui.test.junit4.v2.createComposeRule` (the
  v1 rule is deprecated). Robolectric uses targetSdk 36 by default, which **needs JDK 21**.

**Decisions**

- Single root detekt task (not per-module): detekt 1.23's Android integration uses the variant API
  AGP 9 removed, and detekt 2.0 is still alpha. The rules module compiles against detekt-api
  `compileOnly` with Kotlin `apiVersion = 2.0` (detekt runs on its own Kotlin 2.0 runtime; this gives a
  harmless "API version 2.0 is deprecated" compiler warning) and is loaded non-transitively.
- ktlint through the CLI (`JavaExec`), not the jlleitschuh plugin, because that plugin hooks into
  `org.jetbrains.kotlin.android`, which AGP 9's built-in Kotlin no longer applies.
- `MainActivity` extends `AppCompatActivity` (needed for per-app language below API 33). The Hindi
  default is applied in `Application.onCreate` on API 33+ (no recreate) and in
  `MainActivity.onCreate` below 33 (AppCompat only loads its stored choice there). Only an *unset*
  language is changed, so a user's English choice sticks; picking "System default" in Android 13+
  settings is treated as unset and returns to Hindi on the next start.
- `allowBackup=false` + data extraction rules that exclude everything: the Tink keyset is bound to the
  phone's Keystore, and restoring an old payment queue could resend payments.
- `sentry-android-core` (not `sentry-android`, which adds the NDK integration) to keep the APK small;
  auto-init is off in the manifest and `CrashReporting.init` returns early without a DSN.
- Bottom-bar labels use the new `mobile_shell` namespace rather than `common_search`/`common_today`,
  so the shell owns its words (and "Waiting" did not exist yet).

**Deviations / changes outside apps/android**

- `packages/i18n/src/android.ts` (T-004, done): the generated XML header contained
  `<!-- Regenerate: pnpm --filter @cb/i18n i18n:build -->`; XML forbids `--` inside comments and
  aapt2 rejected both `strings_generated.xml` files. All comments now go through `xmlComment()`, which
  splits `--`; the header now says `Regenerate: pnpm i18n:build (repo root)`. Test added in
  `android.test.ts`; outputs regenerated. `Tokens.kt` (T-002) compiled as is.
- `apps/web/messages/*.json` regenerated (new `mobile_shell` namespace).
- compileSdk 37 instead of 36 (see above). Unit tests need JDK 21 (Robolectric: "Android SDK 36
  requires Java 21"); building needs only JDK 17.
- No launcher icon yet (lint warning `MissingApplicationIcon`): needs the brand from H-02.

**Verification** (JDK 21, Android SDK, Node v24.21.0, pnpm 12.11.2; no emulator: no /dev/kvm)

- `./gradlew clean ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`:
  BUILD SUCCESSFUL. 9 app tests pass: `AppLanguageTest` (3), `BuildConfigTest`,
  `CableAppNavigationTest` (Compose UI on Robolectric, `hi` resources: the three Hindi tabs, start on
  Search, switching Today → Waiting → Search with selected state), `MainActivityTest` at API 26 and 36
  (real Hilt app starts, app locale is set to `hi`, bottom bar shown; at API 26 the labels are Hindi
  after AppCompat's recreate; at API 36 Robolectric's LocaleManager does not apply app locales to
  resources, so only the request is checked there; Sentry stays off). 4 detekt-rule tests pass.
  Lint: 0 errors (1 warning: `MissingApplicationIcon`).
- `./gradlew lint assembleProdRelease`: OK (R8, 2.4 MB unsigned APK).
- Fresh-clone check with **JDK 17** (Temurin 17.0.20), an empty Gradle user home and only the SDK:
  `git archive HEAD apps/android` → `./gradlew ktlintCheck detekt lint assembleDevDebug` BUILD
  SUCCESSFUL. `testDevDebugUnitTest` on JDK 17 fails with Robolectric's "SDK 36 requires Java 21",
  as documented.
- detekt rule fails for real: a file in `:app` with `Color(0xFF00FF00)` and `16.dp` made
  `./gradlew detekt` fail with `RawColorLiteral` and `RawDimensionLiteral`; the same file in
  `core/designsystem` passed. File removed.
- `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `pnpm tokens:build --check`,
  `pnpm --filter @cb/i18n i18n:build --check`, `pnpm generate` (no diff), `node scripts/tasks.mjs
  check --local`: all pass.
- **Not verified:** launching on API 26 / API 35+ emulators (acceptance criterion 2 left unticked).

**Environment notes (agent container, not part of the repo)**

- Maven Central (`repo.maven.apache.org` / `repo1.maven.org`) answered HTTP 429 to Gradle's and
  Robolectric's requests from this container. A local init script
  (`~/.gradle/init.d/central-mirror.init.gradle.kts`, not committed) redirected Maven Central and
  Robolectric's `robolectric.dependency.repo.url` to Google's mirror
  `https://maven-central.storage-download.googleapis.com/maven2/`. The committed build uses plain
  `mavenCentral()`.

## Board log

- 2026-10-13T04:21:04.114Z blocked by coordinator: Android SDK download blocked: network policy denies dl.google.com in this cloud environment. Unblock after the host is allowed.
- 2026-10-13T05:34:04.510Z unblocked by coordinator
- 2026-10-13T05:36:18.925Z claimed by agent-t008
- 2026-10-13T06:22:53.079Z completed on task/T-008-android-project-scaffold
