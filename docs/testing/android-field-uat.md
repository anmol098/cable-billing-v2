# Lineman app: field UAT script (durability, printing, sharing, Hindi)

Owner: T-072. Used by **H-04** (usability round with linemen) and **H-05** (device and printer matrix).
Source rules: PRD §15 #8–#11, PLAN §2.2 (low-literacy UX), §9.2 (shared phones), §11 (lineman app), §16.

This is the human half of the durability proof. The automated half is described at the end
([Automated suite](#automated-suite-what-runs-where)). The automated tests simulate a killed process
inside one process; only this script kills the real process, reboots the real phone, cuts the real
power and uses real printers, WhatsApp and battery savers.

**The one rule behind every step:** a payment the phone said was saved ("पैसे सेव हो गए") is never lost
and reaches the office **exactly once**. Any step where a saved payment disappears, or shows twice on
the web, is a **blocker**: stop, keep the phone as it is, and report it (see [Reporting](#reporting)).

---

## 0. Before the day

### People

| Role | Who | Does |
|---|---|---|
| Tester | QA or product person | Reads this script, runs the phone steps, fills the sheet |
| Lineman (H-04) | Real lineman, ideally one who reads little | Does the **observed** steps (marked 👁) without help |
| Office | Someone at the web app (Owner login) | Checks payments, handovers, switches linemen off/on |

For 👁 steps the tester **does not explain or point**. Note where the lineman hesitates, what they tap
first, and how long the task takes. Help only after 2 minutes of being stuck, and write that down.

### Phones (H-05 matrix; test as many as you can, at least the first three)

| # | Phone | Why |
|---|---|---|
| 1 | Cheap Android 8.0 / 8.1 phone (API 26–27), 2 GB RAM | minSdk; slow storage; old WebView |
| 2 | Xiaomi / Redmi (MIUI / HyperOS), Android 13+ | aggressive autostart and battery limits |
| 3 | Any phone with a **360 × 640 dp** screen (5.0–5.5", or set Display size to Large) | smallest layout we support |
| 4 | Oppo / Realme / Vivo (ColorOS / Funtouch) | "App freeze", deep battery saver |
| 5 | Samsung, Android 14+ | "Sleeping apps", per-app language from system settings |
| 6 | Android 15 or 16 phone (API 35–36) | targetSdk behaviour, Keystore on new OS |

Write down for each phone: make, model, Android version, RAM, OEM skin version, Google TTS Hindi voice
installed (yes/no), WhatsApp / WhatsApp Business installed.

### Printers (H-05)

At least 2–3 different **58 mm Bluetooth ESC/POS** printers (e.g. the models operators already own).
Paper rolls, one printer with an almost empty roll, and the printer's PIN (usually 0000 or 1234).

### Accounts and data (staging)

- Staging operator with seed data (T-036), Owner login for the web.
- **Two** lineman accounts of the same operator: **L1** and **L2**.
- Know 3 customers by code, phone and VC number, one with a due, one with nothing due, one with a
  Hindi name. Write their dues down before starting.
- Install the **staging** build from the Play internal track (or `assembleStagingRelease` side-loaded).
  For step N (app update) you also need the **previous** staging build.

### Phone setup

- App language: Hindi (default). Phone language: test once in Hindi and once in English.
- Turn **off** "Don't keep activities" and other developer options unless a step says otherwise.
- Charge the phone. Note the time on the phone and on the office PC.
- `adb` (USB debugging) on a laptop is needed only for steps C3, G2 and the logcat in [Reporting](#reporting).

### Recording sheet

One row per step and phone:

| Step | Phone # | Pass / Fail | What the screen said (Hindi words) | Time taken | Lineman needed help? | Notes / photo |
|---|---|---|---|---|---|---|

Take a photo or screenshot of every failure **before** touching the phone again.

---

## A. Sign-in, language, small screen

1. Fresh install, open the app. Expect the Hindi sign-in screen; "123 / ABC" switch on the keyboard.
2. Sign in as **L1** with internet. Expect the search home and "ग्राहकों की लिस्ट आ रही है…" then "अभी अपडेट हुआ".
3. 👁 Ask the lineman to switch the app to English and back to Hindi (Settings gear at the end of the
   number row → "हिंदी" / "English"). Record time and whether they found the gear.
4. On phone #3 (360 × 640) and with system font size at **largest**: go through Search, Customer, Collect
   (all four steps), Done, Today, Waiting, Settings in Hindi. **Fail** if any button, amount or word is cut
   off, overlaps, or needs sideways scrolling; if the number pad is pushed below the screen; or if the Save
   button cannot be reached.

## B. Find a customer and collect (👁 H-04 core task)

1. 👁 "Find customer <code> and take ₹<amount> cash." Do not say which buttons.
2. Expect: number pad search, the due large and red, Collect → Amount (pre-filled with the due) → "नकद" /
   "UPI" → Confirm ("देखें और सेव करें", spoken aloud if voice is on) → Save → Done: "पैसे सेव हो गए", a
   temporary number "अस्थायी नं. P-…".
3. With internet the Done screen turns by itself into "रसीद नं. R-…" and "ऑफिस पहुँच गया". On the web the
   payment shows **once**, with the same amount, method and the temporary number linked to the receipt.
4. 👁 Repeat with UPI and a UPI reference, and by name search (ABC key, Hindi name).
5. Record for each: success without help (yes/no), time, wrong taps.

## C. Kill the app right after Save (PRD §15 #8)

Do each of C1–C4 with **internet off** first, then repeat with **internet on**. Write the provisional
number shown on Done each time.

1. **Swipe away:** Save → as soon as "पैसे सेव हो गए" shows, open Recents and swipe the app away.
2. **Force stop:** Save → Android Settings → Apps → Cable Billing → Force stop. (Force stop also cancels
   the app's background jobs until the app is opened again.)
3. **Process kill (adb):** Save → `adb shell am kill com.cablebilling.lineman.staging` (or `.dev`), with
   the app in the background.
4. **Double tap:** tap Save twice quickly; and tap Save, kill the app while "सेव हो रहा है…" shows, open
   the app again and finish the payment again on the restored screen.

Expected after reopening the app (every case):

- The payment is in Waiting ("इंतज़ार में") and Today, with the **same** temporary number.
- The search home strip shows "फ़ोन में N पेमेंट" with the right N.
- With internet on, it turns "ऑफिस पहुँच गया" within a few minutes **without** pressing anything (if not,
  press "अभी भेजें" and note it as a finding).
- On the web: **exactly one** payment per Save. Two payments for one Save = blocker. Zero = blocker.
- C4: one payment only, even after the second Save.

## D. Reboot with payments on the phone

1. Internet off. Save 3 payments. Note the numbers.
2. Restart the phone (power menu → Restart). Do **not** open the app.
3. Turn internet on (mobile data, then separately Wi-Fi). Wait 15 minutes without opening the app.
4. Check the web: did the 3 payments arrive by themselves? Record yes/no and how long it took. (Expected
   on most phones: yes, by WorkManager. On phones with OEM autostart limits it may wait for step 5.)
5. Open the app. Within a minute all 3 are "ऑफिस पहुँच गया"; the web has each **once**.
6. Repeat with a **second** reboot while still offline before turning internet on.

## E. A whole day in airplane mode (👁 partly)

1. Morning with internet: sign in as L1, wait for "अभी अपडेट हुआ".
2. Turn on airplane mode for the whole collection round (at least 10 payments, cash and UPI, over at
   least 2 hours; a real round is best).
3. During the day check: search still finds customers by code, phone and VC; the due after a payment
   goes down on the phone ("फ़ोन में सेव पेमेंट मिलाकर"); Done says "इंटरनेट आने पर यह अपने-आप ऑफिस पहुँच
   जाएगा।"; Today shows cash and UPI separately and "इस फ़ोन में गिना…"; the strip says "इंटरनेट नहीं है · …".
4. Kill the app at least twice during the day (C1 / C2) and turn the screen off for long stretches.
5. 👁 At the end, hand over the cash offline (Today → hand over): the pad is pre-filled with all cash of
   the day; Confirm; Today says "फ़ोन में सेव। इंटरनेट आने पर अपने-आप ऑफिस जाएगा।".
6. Evening: airplane mode off. Expected without pressing anything (open the app if nothing moves after
   15 minutes): every payment "ऑफिस पहुँच गया", then the handover reaches the office, then the print /
   WhatsApp records. On the web: the day's count and cash/UPI totals equal the phone's; each payment once;
   one handover whose expected cash already counts the day's payments.

## F. Power cut right after Save

1. Phone with a removable battery, or a phone you may hard-reset: Save a payment, wait 2 seconds after
   "पैसे सेव हो गए", then pull the battery (or hold power + volume down until it powers off; this is
   **not** the same as a clean shutdown, note which one you did).
2. Start the phone, open the app. The payment must be there.
3. Repeat 5 times on each phone you can. Any lost payment = blocker; attach the logcat line
   `CableDurability … synchronous=` from the automated suite on that phone model if you have it
   (WAL with `synchronous=1` can lose the last commits on a power cut).

## G. Battery savers and Doze

1. Turn on the phone's battery saver / "ultra" saver. Internet off, save 2 payments, lock the phone for
   30 minutes, turn internet on, keep the phone locked for 30 more minutes. Did they arrive without
   opening the app? Record per phone (Xiaomi "Battery saver: restrict", Oppo "App freeze", Samsung
   "Sleeping apps", Vivo "High background power consumption" off).
2. Doze (with adb): `adb shell dumpsys deviceidle force-idle`, wait, then `adb shell dumpsys deviceidle
   unforce`. Payments must still arrive (later is fine, lost is not).
3. Opening the app must always send them within a minute. Write down which phones need the app opened;
   operators may have to be told to allow "Autostart" for the app (a support note, not a bug).

## H. Lost answers and retries (PRD §15 #8 "not duplicated")

1. Weak network: walk to a spot with one bar (or use a phone hotspot that you turn off). Save, and turn
   the network off **right after** the Done screen appears; turn it on after 10 seconds. Repeat 10 times.
2. In Waiting, tap "अभी भेजें" and turn on airplane mode at the same moment. Repeat 5 times.
3. Expected: every payment on the web **once**; the phone ends with "ऑफिस पहुँच गया" for each; no payment
   in "दिक्कत" ("ऑफिस ने यह पेमेंट नहीं लिया") because of the network.

## I. Printing on a real 58 mm printer (PRD §15 #10)

1. Settings → Set up printer → pair (PIN 0000 / 1234) → Test print. Hindi and English sample lines must be
   readable and fit the paper width.
2. After a cash and a UPI payment: Print from Done. Check: operator name, receipt or temporary number,
   date and time, customer name (Hindi name prints correctly), amount, method, UPI ref, bills paid, due
   now, lineman, footer.
3. Print the same receipt after it reached the office: it now shows "रसीद नं. R-…" and the bills.
4. Failures, one by one: printer off; out of paper; printer walks away mid-print; Bluetooth off; app
   killed while printing. Each time the screen says what went wrong and "पेमेंट सेव है। सिर्फ़ प्रिंट नहीं
   हुआ।", and the payment is still there and reaches the office once.
5. Record per printer model: pass/fail, print time, any garbled or cut text (H-05 `docs/printers.md`).

## J. WhatsApp, SMS and PDF: honest words only (PRD §15 #11)

1. Done → WhatsApp: confirm or change the customer's number on the big pad (10 digits from 6–9).
   Offline: "इंटरनेट आने पर लिंक तैयार होगा।"; turn internet on, the link becomes ready by itself.
2. "WhatsApp खोलें" opens WhatsApp (or WhatsApp Business) on that number with the Hindi message and link.
   The app afterwards may say only "WhatsApp opened" style words. **Fail** if anything on screen says the
   message was "sent", "delivered", "भेज दिया" or "पहुँच गया" for a WhatsApp/SMS message.
3. "PDF शेयर करें" works offline and opens WhatsApp or the share sheet; the PDF opens and Hindi is shaped.
4. SMS: opens the SMS app with the text filled in.
5. Phone without WhatsApp: the app says WhatsApp is not on the phone and offers SMS / PDF.
6. In every failure case the payment is untouched.

## K. Two linemen on one phone (PLAN §9.2)

1. L1 signed in, internet off, saves 2 payments.
2. L1 tries to sign out: the app refuses ("अभी लॉग आउट नहीं हो सकता") and says the payments are safe.
3. Get L1 signed out anyway the way the field does: the Owner signs the phone out on the web (step L) or
   switches L1 off. Then sign in as **L2** with internet on.
4. L2 collects 1 payment. Expected: L2's payment reaches the office; L1's 2 stay on the phone, flagged
   "दूसरा लाइनमैन" in Waiting with "ऑफिस को फ़ोन करें"; the web never shows L1's payments under L2.
5. Kill the app and reboot once; L1's payments are still there and still held.
6. L2 signs out, L1 signs in again: L1's payments reach the office once, under L1.

## L. Deactivated lineman, signed-out phone

1. L1 has 2 payments on the phone (internet off). Office switches L1 off on the web.
2. Internet on. Expected: the app goes to sign-in with "आपका अकाउंट बंद है। ऑफिस को फ़ोन करें। फ़ोन में
   सेव पेमेंट सुरक्षित हैं।"; the payments stay on the phone (they are **not** sent and **not** deleted).
3. Repeat with the Owner signing the phone out instead ("ऑफिस ने इस फ़ोन से लॉग आउट कर दिया है…").
4. Office switches L1 on again (or L1 signs in after being reactivated): the payments go once.
5. Note for the product owner: the office cannot yet release a switched-off lineman's payments from the
   web (open question in T-066). Record how long they sat on the phone.

## M. Cash handover (PRD §15 #12)

1. 👁 "Give today's cash to the office." With internet: the pad shows the expected cash; giving less asks
   "फ़र्क क्यों है?" with tiles; Confirm reads the amount aloud.
2. Offline handover, then kill the app, then internet on: the office gets **one** handover.
3. Office sends it back with a note → the phone shows the note and "फिर से कैश दें"; office accepts →
   "मंज़ूर", no more button.

## N. App update keeps the queue (Room migration)

1. Install the **previous** staging build. Sign in, internet off, save 3 payments, print one, save a
   handover offline.
2. Install the **new** build over it (Play internal track update, or `adb install -r`). Do not uninstall.
3. Open the app: same sign-in, same 3 payments with the same temporary numbers, the handover still
   waiting, the customer list still searchable offline.
4. Internet on: everything reaches the office once.
5. Also try with the "New app version needed" screen (office raises the minimum version): the screen says
   payments are safe; after updating they go.

## Reporting

- A failure report has: step, phone #, app version (Settings shows "App version …"), time, photos, and
  the **app report**: Settings → "Share app report" (it has no names, numbers or amounts) → send to the
  developers.
- For C, D, F, G, H also attach `adb logcat -d > logcat.txt` taken right after the failure, if a laptop is
  there.
- Do not clear app data or reinstall a phone with a lost or doubled payment until a developer says so.
- H-04 findings become tasks on the board; H-05 results go to `docs/printers.md` and `docs/testing/devices.md`.

---

## Automated suite: what runs where

| Suite | Where the code is | Runs |
|---|---|---|
| Durability + migration scenarios (process death after Save, reboot with the WorkManager test driver, airplane-mode day, duplicate retry, two linemen and a switched-off lineman, lost Keystore key, Room v1 → current, no destructive migration, SQLite journal settings) | `apps/android/app/src/androidTest/shared/java/com/cablebilling/lineman/durability/` | **Every PR on Robolectric** (part of `./gradlew testDevDebugUnitTest`, CI job "Android"), and as **instrumented tests** on an emulator or phone (`connectedDevDebugAndroidTest`) |
| Full offline field day with every outbox (roster, payments, receipt actions, handover) against the contract fixtures | `apps/android/app/src/test/java/com/cablebilling/lineman/durability/` | Robolectric only (needs `packages/contracts` fixtures) |
| Instrumented runner (plain `Application`, so `CableApplication` and Hilt do not start) | `apps/android/app/src/androidTest/java/com/cablebilling/lineman/durability/DurabilityTestRunner.kt` | instrumented runs |

What the instrumented run adds over Robolectric: the phone's real SQLite and file system, a real Android
Keystore key sealing the session across restarts, the real WorkManager/JobScheduler process model, and
the device's SQLite journal settings (`DatabaseSafetyTest` logs `CableDurability cable.db
journal_mode=… synchronous=…` and fails if `synchronous` is OFF). What it does **not** do: kill the real
process, reboot, cut power or switch real radios. That is sections C–H above.

### Run it on an emulator or phone

```bash
cd apps/android
./gradlew connectedDevDebugAndroidTest            # every androidTest on all connected devices
# only the durability package:
./gradlew connectedDevDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.package=com.cablebilling.lineman.durability
adb logcat -d -s CableDurability                  # the SQLite settings line
```

On a phone that has real data in the dev app, `DatabaseSafetyTest` skips itself (it never touches an
existing `cable.db`); everything else uses its own files in the test's cache folder.

### Proposed CI job (nightly + manual), not yet added

Workflow files are not in T-072's paths (tasks/README.md §6), so this is a proposal for the
coordinator. Emulators need KVM, which GitHub's Linux runners provide; one API level takes roughly
10–15 minutes including boot, so it runs nightly and on demand rather than on every PR (the same
scenarios already run on Robolectric in the PR job). Pin the actions to commit SHAs like `android.yml`.

```yaml
# .github/workflows/android-device-tests.yml
name: Android device tests
on:
  schedule:
    - cron: "40 21 * * *"   # 03:10 IST
  workflow_dispatch:
permissions:
  contents: read
jobs:
  instrumented:
    name: Instrumented (API ${{ matrix.api }})
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    strategy:
      fail-fast: false
      matrix:
        api: [26, 35]
    defaults:
      run:
        working-directory: apps/android
    steps:
      - uses: actions/checkout@<sha> # v7
        with:
          persist-credentials: false
      - uses: actions/setup-java@<sha> # v6
        with:
          distribution: temurin
          java-version: "21"
      - uses: android-actions/setup-android@<sha> # v4
        with:
          log-accepted-android-sdk-licenses: false
      - uses: gradle/actions/setup-gradle@<sha> # v6
        with:
          cache-provider: basic
          cache-read-only: true
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
      - name: Build the app and test APKs
        run: ./gradlew --stacktrace assembleDevDebug assembleDevDebugAndroidTest
      - name: Run on the emulator
        uses: reactivecircus/android-emulator-runner@<sha> # v2
        with:
          api-level: ${{ matrix.api }}
          target: google_apis
          arch: x86_64
          disable-animations: true
          emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -no-snapshot
          working-directory: apps/android
          script: |
            ./gradlew --stacktrace connectedDevDebugAndroidTest
            adb logcat -d -s CableDurability || true
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@<sha> # v7
        with:
          name: android-device-tests-api${{ matrix.api }}
          path: |
            apps/android/app/build/reports/androidTests/
            apps/android/app/build/outputs/androidTest-results/
          retention-days: 14
          if-no-files-found: ignore
```

An alternative without a third-party action is Gradle Managed Devices
(`android.testOptions.managedDevices`, `./gradlew api26DevDebugAndroidTest`); it needs a block in
`app/build.gradle.kts` and still needs KVM on the runner.
