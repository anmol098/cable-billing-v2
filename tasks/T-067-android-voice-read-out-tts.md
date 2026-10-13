---
id: T-067
title: Android: voice read-out (TTS)
phase: 3
area: android
status: done
owner: agent-t067
claimed_at: 2026-10-13T10:25:40.431Z
branch: task/T-067-android-voice-read-out-tts
depends_on: [T-009]
review: self
claimable_by: agent
size: S
paths: [apps/android/app/src/main/java/com/cablebilling/lineman/voice/**, packages/i18n/messages/*/mobile_voice.json]
---

# T-067 — Android: voice read-out (TTS)

**Phase** 3 · **Area** android · **Size** S · **Review** self · **Claimable by** agent · **Depends on** T-009

## Goal

The phone speaks key moments in Hindi.

## Scope

- `TtsSpeaker` implementing `Speaker` with hi-IN, English fallback, mute persisted, queue flush on navigation.
- Amount phrasing helper ('चार सौ पचास रुपये').
- One-time icon-led prompt to install Hindi voice data if missing; never blocks.

## Acceptance criteria

- [x] With TTS unavailable the app behaves exactly as with NoOpSpeaker.

## Tests required

- Unit tests for phrasing (₹1, ₹450, ₹1,00,000) in hi + en.

## Files this task owns

Edit only these paths, plus the shared files listed in `tasks/README.md` §6.

- `apps/android/app/src/main/java/com/cablebilling/lineman/voice/**`
- `packages/i18n/messages/*/mobile_voice.json`

## References

PLAN §11.3 (Voice column), D-10 — see `docs/IMPLEMENTATION_PLAN.md`, `docs/PRD.md`, `docs/BRD.md`.

## Completion notes

**What exists** (package `com.cablebilling.lineman.voice`, `apps/android/app/src/main/java/.../voice/`)

- `TtsSpeaker` implements `Speaker` (T-009) on Android `TextToSpeech`, and `SpeakerModule` now binds
  it (`@Singleton TtsSpeaker`, `Speaker = TtsSpeaker`). Behaviour:
  - Hindi `hi-IN` first; English fallback (`en-IN`, then `en-US`/`en-GB`/`en`, an exact country
    match preferred). If the app language is English, English is first and Hindi the fallback.
  - `say` uses `QUEUE_FLUSH` (replaces whatever is speaking), never blocks, never throws. The engine
    starts lazily (first `say` or `warmUp()`); a read-out asked for while it starts waits (only the
    latest) and is spoken when it is ready.
  - Mute persisted in the app's `settings` DataStore (`voice_muted`) through `VoiceSettings` /
    `DataStoreVoiceSettings`. A stored mute is loaded before anything is spoken; muting stops speech.
  - `status: StateFlow<VoiceStatus>`: `Off` → `Starting` → `Ready(languages, hindiNeedsDownload)` or
    `Unavailable`. **Unavailable** (no engine, the constructor throws, init fails, or neither
    language exists) = silent, the engine is released, and every call behaves like `NoOpSpeaker`
    (mute still works and is remembered). `warmUp()` retries.
  - Lifecycle: `warmUp()` (start, retry, or re-check voices if Hindi was missing), `stop()`,
    `shutdown()` (release; the next read-out starts again). Thread-safe (one lock); handles engines
    that answer inside the `TextToSpeech` constructor and late answers from released engines.
- `SpokenAmount.words(paise, VoiceLanguage)`: Indian numbering, whole rupees (D-17) —
  "चार सौ पचास रुपये" / "four hundred fifty rupees", "एक रुपया" / "one rupee", "एक लाख रुपये" /
  "one lakh rupees", "बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ रुपये", crore (recursive above 99 crore).
  Full Hindi table 0–99. Sign dropped (like `Rupees.format`). A paise remainder is spoken
  ("बारह रुपये पचास पैसे") instead of being rounded away. `SpokenAmount.number(n, language)` too.
- `VoiceLine(hindi, english)` + `VoiceLines` (@Singleton, injectable): builds read-outs in both
  languages from resources whatever the app language is. Ready-made: `customerDue(name, duePaise)`,
  `collected(name, amountPaise, PaymentMethod)`, `moneySaved()`, `amount(paise)`, plus generic
  `line(@StringRes id, args)` and `line { language -> … }`.
- Compose (`VoiceCompose.kt`): `VoiceHost()` (mounted once in `MainActivity`: `warmUp` on start,
  `stop` on stop, `shutdown` when the activity finishes, and the prompt), `SpeakOnShow(line)`,
  `spokenText(line)`, extensions `Speaker.say(line)` / `Speaker.stop(line)`.
- One-time Hindi voice prompt (`HindiVoicePrompt`, a dismissible dialog): speaker + download icons,
  one sentence, a big "डाउनलोड करें" button that opens `TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA`
  (aimed at the default engine) and "बाद में". Shown only when the app is in Hindi, the Hindi voice
  is missing (or its data is not downloaded), the phone can open the download screen, and it was
  never shown (`voice_hindi_prompt_shown` in DataStore, set as soon as it shows). Back / outside
  tap / "Later" close it; nothing waits for it.
- i18n namespace `mobile_voice` (`R.string.mobile_voice_*`): `hindi_voice_missing`,
  `hindi_voice_download`, `hindi_voice_later`, `customer_due`, `cash_from`, `upi_from`,
  `money_saved`. All Hindi in `_review` (H-03).

**How screens speak (T-065 / T-066 / T-070 …)**

```kotlin
// ViewModel: inject VoiceLines (and Speaker or TtsSpeaker)
val line = voiceLines.customerDue(customer.name, customer.duePaise)   // VoiceLine
// Composable: speak on entry, stop on leaving (does not cut off the next screen's read-out)
SpeakOnShow(line)
// Replay button (T-009 SpeakButton takes plain text): pass the text in the voice the phone has
SpeakButton(text = spokenText(line), label = stringResource(R.string.mobile_designsystem_speak))
// Anywhere with a Speaker: speaker.say(line) (extension), speaker.stop(line)
```

New phrases: add a key to `mobile_voice` (or the screen's own namespace) with the amount as a
`{amount}` argument and build it with `voiceLines.line { lang -> voiceLines.text(lang, R.string.x,
SpokenAmount.words(paise, lang)) }`. Never put "₹" or digits for amounts in spoken text.

**Decisions**

- Read-outs are `VoiceLine`s (both languages) so the English fallback says English words. Plain
  `say(text)` picks the voice by script: Devanagari needs the Hindi voice (silent without it; an
  English voice cannot read it), Latin text uses any voice.
- `money_saved` says "पैसे फ़ोन में सेव हो गए / Money saved on phone" rather than PLAN §11.3's
  "पैसे सेव हो गए": glossary "Saved on phone" and BR-11 honest states.
- Prompt is a dialog (not a banner) so no other task's layout changes; it is dismissible and shown
  once. The download icon is `ic_cb_export` (Lucide "download"); no new icon meaning was added.
- `warmUp()` restarts the engine on every app start while Hindi is missing, so a voice downloaded
  from the prompt is picked up when the lineman returns.

**Deviations / changes outside the owned paths**

- `MainActivity.kt` (T-008, done): one line mounts `VoiceHost(speaker)` inside `CableTheme`.
- `AndroidManifest.xml` (§6 shared): `<queries>` for `android.intent.action.TTS_SERVICE` and
  `android.speech.tts.engine.INSTALL_TTS_DATA` (package visibility on API 30+: without them the
  app cannot see the TTS engine or its download screen).
- Regenerated `strings_generated.xml` (en/hi) and `apps/web/messages/{en,hi}.json`.

**Follow-ups (no task created)**

- **On-device check needed** (no emulator here): real Google TTS with and without the Hindi voice,
  the download screen, an API 26 phone, and a phone with no TTS engine.
- **App bundle language splits (for T-073):** lint warns `AppBundleLocaleChanges` (VoiceLines reads
  Hindi strings via `setLocale`; T-008's per-app language does the same through AppCompat, which lint
  does not detect). Before the first Play upload, set `bundle { language { enableSplit = false } }`
  in `app/build.gradle.kts`, or Hindi strings may be missing on phones whose system language is
  English.
- Hindi number words in `SpokenAmount` (code, not i18n) should be part of the H-03 review.
- A customer name typed in Devanagari is read badly by the English fallback voice (names are not
  transliterated).

**Verification** (JDK 21, Android SDK 36/37, Node v24.21.0, pnpm 12.11.2; no emulator: no /dev/kvm)

- `./gradlew ktlintCheck detekt lint testDevDebugUnitTest assembleDevDebug :detekt-rules:test`:
  BUILD SUCCESSFUL. 40 new JVM tests in `app/src/test/.../voice/`, all pass (app total 51,
  designsystem 31, detekt-rules 4): `SpokenAmountTest` 8 (₹1, ₹450, ₹1,00,000 in hi + en; 0, 2,
  99, 100, 101, 500, 1,000, 1,050, 10,000, 99,999, 1,00,001, 12,34,567, 1 crore, 2.5 crore, 100
  crore, 1,234 crore; paise; sign; Long.MIN/MAX; 100 distinct Hindi words), `TtsSpeakerTest` 18
  (Robolectric `ShadowTextToSpeech`: init success, hi-IN + QUEUE_FLUSH, pending latest only,
  English fallback, English app language, en-US, not-installed Hindi data, init failure, engine
  answering inside its constructor, constructor throwing, no language, mute + stop, stored mute,
  `stop(line)`, shutdown + late answer, `warmUp` retry/re-check, prompt offer rules),
  `TtsUnavailableTest` 2 + `AppWithoutTtsTest` 1 (**acceptance**: three unavailable cases compared
  step by step with `NoOpSpeaker`, the same for `VoiceToggle` / `SpeakButton` / `VoiceHost` /
  `SpeakOnShow` semantics trees, and the real Hilt app with a failing engine), `VoiceHostTest` 6
  (engine starts with the screen, prompt shows once in Hindi with ≥ 64dp buttons, Later, Download
  opens `ACTION_INSTALL_TTS_DATA`, no prompt when Hindi exists or after it was shown, `SpeakOnShow`
  across screens, `spokenText` fallback), `VoicePersistenceTest` 2 (mute and prompt survive a restart: the
  DataStore is closed and a new one reads the same file; an earlier version that re-read the same
  DataStore instance right after a write was flaky here, about 1 run in 4, so it now waits for the
  write and models the restart; 10/10 runs green), `VoiceLinesTest` 3. Lint: 0 errors, 2 warnings
  (`MissingApplicationIcon` existing; `AppBundleLocaleChanges` new, see follow-ups).
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm generate` (no diff), `pnpm tokens:build --check`, `pnpm icons:build --check`,
  `pnpm --filter @cb/i18n i18n:build --check`, `node scripts/tasks.mjs check --local`: all pass.

## Board log

- 2026-10-13T10:25:40.431Z claimed by agent-t067
- 2026-10-13T10:50:20.240Z completed on task/T-067-android-voice-read-out-tts
