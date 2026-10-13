---
id: T-009
title: Android design-system components
phase: 0
area: android
status: done
owner: agent-t009
claimed_at: 2026-10-13T06:28:05.828Z
branch: task/T-009-android-design-system-components
depends_on: [T-008, T-003]
review: self
claimable_by: agent
size: M
paths: [apps/android/core/designsystem/**]
---

# T-009 — Android design-system components

**Phase** 0 · **Area** android · **Size** M · **Review** self · **Claimable by** agent · **Depends on** T-008, T-003

## Goal

The low-literacy component kit every Android screen uses.

## Scope

- BigButton (64dp, icon + word), MethodButton (Cash green / UPI blue tiles), NumberPad (0–9, ⌫, 00, optional ABC key; haptic feedback), AmountDisplay (₹, Indian grouping, 44sp), StatusChip (saved-on-phone / sent / needs-help), CustomerRow, SyncBanner, ConfirmCard, ReceiptActionTile, SpeakButton.
- `Speaker` interface (`say(text: String)`, `stop()`, `isMuted`) + `NoOpSpeaker` provided via Hilt so screens can call it before T-067 lands.
- Preview catalogue screen (debug builds only) showing all components in hi + en.

## Acceptance criteria

- [x] All touch targets ≥ 56dp; primary buttons 64dp; body ≥ 18sp.
- [x] No raw colours/dimens outside generated tokens.

## Tests required

- Compose UI tests for NumberPad input and AmountDisplay formatting (₹1,23,456).

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/core/designsystem/**`

## References

PLAN §6.4, PLAN §2.2, PLAN §11.3, D-10 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (package `com.cablebilling.designsystem`, module `:core:designsystem`)

- `component/`: the kit. Every component takes its words as `String` parameters (screens pass
  `stringResource(R.string.…)`), uses tokens only (no `.dp`/`.sp`/`Color(` literals, even though
  detekt would allow them in this module) and is flat (no shadows/elevation).
- `money/Rupees`: `format(paise: Long)` → `"₹1,23,456"` (absolute value; `"₹12.50"` only when not
  whole), `groupIndian(digits)`, `digitsToPaise(digits): Long?` (whole-rupee digits → paise, max 13
  digits), `PAISE_PER_RUPEE`, `MAX_RUPEE_DIGITS`. Same rules and test cases as the web's
  `packages/ui/src/lib/money.ts`.
- `voice/Speaker` (`isMuted: StateFlow<Boolean>`, `setMuted(Boolean)`, `say(text)`, `stop()`),
  `NoOpSpeaker`, `LocalSpeaker` (defaults to a NoOpSpeaker).
- `theme/CableSizes`: `TouchMin` (56), `PrimaryButton` (64), `Icon` (24), `IconLarge` (40),
  `NumberPadKey` (= PrimaryButton), `Tile` (= 2 × PrimaryButton = 128). `NumericTypography` gained
  `amountSmall` (Xl, list rows) and `key` (Xxl, number-pad digits).
- `:app`: `voice/SpeakerModule` (Hilt, `@Singleton Speaker = NoOpSpeaker()`); `MainActivity` injects
  `Speaker` and provides it as `LocalSpeaker`. Debug-only catalogue in `app/src/debug`
  (`ComponentCatalogueActivity`, a second launcher icon "Components (test)" / "कॉम्पोनेंट (टेस्ट)")
  shows every component with real strings and a हिंदी / English switch (local resources + font; the
  app language is not touched). Not in release builds (checked: the prodRelease merged manifest has
  no catalogue activity, and prodRelease Kotlin compiles).

**Component APIs for T-063 … T-071** (import `com.cablebilling.designsystem.component.*`)

| Component | Signature (required → optional) | Notes |
|---|---|---|
| `BigButton` | `(text, icon: Painter, onClick, modifier, style = BigButtonStyle.Primary, enabled = true)` | Full width, ≥ 64dp, icon + word, 22sp. Styles: `Primary` (black), `Success` (green: the final Save), `Secondary` (outlined). |
| `MethodButton` | `(method: PaymentMethod, text, onClick, modifier, enabled)` | Cash green / UPI blue filled tile, ≥ 128dp; put two side by side with `Modifier.weight(1f)`. `PaymentMethod.Cash/Upi` has `.icon` (drawable) and `.color` (composable). |
| `NumberPad` | `(onKey: (NumberPadKey) -> Unit, deleteLabel, modifier, extraKey = NumberPadExtraKey.DoubleZero, enabled)` | Keys 1–9, then [extra] 0 ⌫. `extraKey`: `DoubleZero` (amounts), `Letters(label)` ("ABC", search), `None`. Long press ⌫ = `NumberPadKey.Clear`. Haptics: `KeyboardTap` per press, `LongPress` for Clear (via `LocalHapticFeedback`). Stateless: keep the digits in your state and use `key.applyTo(digits, maxLength, trimLeadingZeros)` (true for amounts; false for search so phone numbers keep a leading 0). Test tags: `NumberPadTags.digit(n)`, `DOUBLE_ZERO`, `BACKSPACE`, `LETTERS`. |
| `AmountDisplay` | `(amountPaise: Long, modifier, tone = AmountTone.Neutral, dueLabel?, creditLabel?, style = numericTypography.amount, labelStyle = titleMedium, labelBelow = false)` | 44sp tabular Inter. Tones like the web `<Amount>`: `Balance` (> 0 due red, 0 neutral), `Due`, `Credit`; a negative amount is always credit, shown without a minus. Pass `dueLabel` / `creditLabel` (`common_due` / `common_credit`) so colour is never alone. Tags `AmountDisplayTags.AMOUNT/LABEL`. |
| `StatusChip` | `(status: PaymentStatus, text, modifier)` | `SavedOnPhone` (amber clock, `common_saved_on_phone`), `Sent` (green tick, `common_sent_to_office`), `NeedsHelp` (red triangle, `common_problem`). Not tappable. |
| `CustomerRow` | `(name, code, balancePaise, onClick, modifier, area?, dueLabel?, creditLabel?)` | Search result row ≥ 56dp; due large (26sp) red with its word under it; hairline divider. |
| `SyncBanner` | `(state: SyncState, text, modifier, onClick?)` | `Updated` (green tick), `Waiting` (amber clock; also for "no internet"), `Problem` (red). With `onClick` it is a ≥ 56dp button (e.g. open Waiting). `text` is the full sentence from the screen. |
| `ConfirmCard` | `(customerName, amountPaise, method, methodLabel, modifier, details: (ColumnScope.() -> Unit)?)` | Name, 44sp amount, method icon + colour + word; `details` for e.g. the UPI ref. Put a `BigButton(style = Success)` under it. |
| `ReceiptActionTile` | `(text, icon: Painter, onClick, modifier, stateText?, enabled)` | ≥ 128dp outlined tile; `stateText` for honest outcomes ("WhatsApp खुल गया"), never "sent". |
| `SpeakButton` | `(text, label, modifier, speaker = LocalSpeaker.current)` | Speaker icon + word ("सुनें", `mobile_designsystem_speak`). If muted it shows the mute icon, and a tap unmutes then speaks. |
| `VoiceToggle` | `(onLabel, offLabel, modifier, speaker = LocalSpeaker.current)` | The always-visible mute switch (Role.Switch); muting also calls `stop()`. |

Icons: `painterResource(DesignR.drawable.ic_cb_<name>)` (`import com.cablebilling.designsystem.R as
DesignR`). New here: `ic_cb_backspace` (Lucide `delete`). T-007 added `ic_cb_close` / `ic_cb_next`.

Strings: new namespace `mobile_designsystem` (`R.string.mobile_designsystem_*`): `numpad_delete`,
`numpad_letters`, `speak`, `voice_on`, `voice_off` (use these with the components above), plus
`catalogue_*` sample copy used only by the debug catalogue. All Hindi is in `_review` (H-03).

Speaker for T-067: implement `Speaker` (contract in its KDoc: `say` replaces the current speech, is
silent while muted and never throws) and change the one line in `app/.../voice/SpeakerModule.kt`.
ViewModels inject `Speaker`; composables use `LocalSpeaker.current`.

**Decisions**

- Strings stay out of `:core:designsystem` (`strings_generated.xml` lives in `:app` and R classes
  are non-transitive): components take words as parameters, a11y labels included (`deleteLabel`, …).
  So the catalogue lives in `:app`'s `src/debug` source set (debug builds only, own manifest).
- Hilt binding in `:app` (`voice/SpeakerModule.kt`, T-067's future path) rather than adding the Hilt
  plugin/KSP to the design-system module: T-067 replaces the binding in its own path, and Hilt does
  not allow overriding a library module's binding. `MainActivity` (T-008, done) provides
  `LocalSpeaker`.
- `isMuted` is a `StateFlow<Boolean>` (+ `setMuted`) rather than a plain Boolean, so the voice
  buttons recompose when it changes.
- Icon sizes are tokens: added `size.icon` (web 20 / android 24) and `size.iconLarge` (web 32 /
  android 40) to `packages/design-tokens/tokens.json`. Tile and key heights are derived from
  `Tokens.Size.PrimaryButton` in `CableSizes` instead of new tokens.
- `NumberPad` haptics use Compose's `LocalHapticFeedback` (`KeyboardTap` / `LongPress`), with
  `combinedClickable`'s own long-press haptic turned off so a long press buzzes once.
- `:core:designsystem` has its own Robolectric tests; a `testDevDebugUnitTest` alias task in its
  build file runs them as part of the standard check command (the library has no flavours).
- The catalogue's section headings are the component class names (code identifiers, debug only), so
  they are not i18n keys. Everything else a user reads comes from string resources.

**Deviations / changes outside `apps/android/core/designsystem/**`**

- `packages/design-tokens/tokens.json` (+ regenerated `Tokens.kt` and `packages/ui/src/theme.css`:
  `--spacing-icon`, `--spacing-icon-large`), `packages/design-tokens/src/kotlin.test.ts` (expects
  the two new sizes), `packages/ui/src/lib/cn.ts` (`THEME_SIZES` += `icon`, `icon-large`; its drift
  test requires it). Web build and tests pass.
- `packages/design-tokens/icons.json`: `"backspace": "delete"` (+ regenerated `ic_cb_backspace.xml`
  and `packages/ui/src/icons/icons.generated.ts`).
- `packages/i18n/messages/{en,hi}/mobile_designsystem.json` (new) + regenerated
  `strings_generated.xml` and `apps/web/messages/*.json`.
- `apps/android/gradle/libs.versions.toml`: `kotlinx-coroutines-core` alias added.
- `apps/android/app`: `MainActivity.kt` (LocalSpeaker), `voice/SpeakerModule.kt`, `src/debug/**`
  (catalogue + debug manifest), `src/testDebug/**` (catalogue test). `apps/android/README.md`: a
  components / catalogue section.
- The catalogue test names are camelCase: detekt's test-file excludes cover `src/test`, not
  `src/testDebug`.

**Follow-ups (no task created)**

- Look at the components on a real phone or emulator (none here: no /dev/kvm). Robolectric measures
  Devanagari text very narrow, so the visual layout of Hindi was not judged.
- Lucide licence notice in an in-app licences screen (T-003 follow-up, still open).

**Verification** (JDK 21, Android SDK 36/37, Node v24.21.0, pnpm 12.11.2; after rebasing onto
`497579b`, T-007)

- `./gradlew clean ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`:
  BUILD SUCCESSFUL. 46 JVM tests, 0 failures. designsystem 31: `RupeesTest` 5, `NumberPadKeyTest` 4,
  `NumberPadTest` 7 (typing → `₹1,23,456`, every digit, 00 / ⌫ / long-press clear, haptic sequence,
  ABC key, key heights ≥ 64dp, disabled pad), `AmountDisplayTest` 7 (`₹1,23,456`, 44sp + tnum +
  weight, `₹12.50`, due red + word, credit green without a minus, zero neutral, tone resolution),
  `ComponentsTest` 8 (every tappable node of every component ≥ 56×56dp, BigButton ≥ 64dp, tiles ≥
  128dp, every text ≥ 18sp, callbacks, fixed colours, disabled button, speak/unmute, voice toggle,
  NoOpSpeaker). app 11, including the new `ComponentCatalogueTest` 2 (all sections in Hindi, then in
  English after the switch; the catalogue's amount pad types `₹1,23,456`). detekt-rules 4. Lint:
  0 errors (1 existing warning, `MissingApplicationIcon`).
- The size and text sweeps are not vacuous: temporarily setting `CableSizes.NumberPadKey` to 24dp and
  the StatusChip text to `labelSmall` (16sp) made 3 tests fail; reverted.
- The debug APK manifest contains `ComponentCatalogueActivity`; `:app:compileProdReleaseKotlin
  :app:processProdReleaseMainManifest` succeed and the release manifest has no catalogue.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` (9/9), `pnpm test` (9/9),
  `pnpm build` (9/9), `pnpm generate` (no diff), `pnpm tokens:build --check`,
  `pnpm icons:build --check`, `pnpm --filter @cb/i18n i18n:build --check`,
  `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T06:28:05.828Z claimed by agent-t009
- 2026-10-13T07:02:15.074Z completed on task/T-009-android-design-system-components
