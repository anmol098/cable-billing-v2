# Glossary: plain words for Cable Billing

Every user-facing string uses these words, in both languages. Linemen read numbers well and words
poorly; operators are mid-literate (PLAN §2.1, §2.2 rule 5). When a word you need is missing, add it
here in the same PR as the strings that use it.

- **Short, everyday words.** Hindi is spoken Hindi in Devanagari, not formal or Sanskritised Hindi.
  English loanwords that people already use (बिल, कैश, पेमेंट, प्रिंट) beat "correct" Hindi
  (देयक, नकदी राशि, भुगतान, मुद्रण).
- **One word per idea.** If the glossary says "Bill", never write "Invoice" for the same thing.
- **Pair every word with its icon and colour** (PLAN §2.2 rule 3 and 4). The icon column suggests a
  Lucide icon; the canonical semantic map is `packages/design-tokens/icons.json` (T-003).
- **Product-owner review (D-23).** All Hindi here was drafted by an agent and is reviewed in H-03.

## Core terms

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Cable Billing | केबल बिलिंग | Product name (D-21) | — | — |
| Bill | बिल | The monthly amount we ask a customer to pay | receipt | Invoice, इनवॉइस, देयक |
| Receipt | रसीद | Proof that we took money | receipt | Voucher, पावती |
| Receipt no. | रसीद नं. | `R-2610-00045` (or provisional `P-…`) | — | Transaction ID |
| Customer | ग्राहक | A household or shop that pays us | person | Subscriber, Account |
| Connection (VC) | कनेक्शन (VC) | One set-top box / viewing card on a customer | tv | Service, Subscription, VC alone |
| VC number | VC नंबर | The number printed on the card | — | Smart card ID, STB serial |
| Set-top box | सेट-टॉप बॉक्स | The device itself | tv | STB |
| Plan | प्लान | Monthly price for a connection | — | Package, Tariff, पैकेज |
| Area | एरिया | Part of town a lineman covers | map-pin | Zone, Route, Beat |
| Lineman | लाइनमैन | Field worker who collects money | — | Collector, Agent |
| Office | ऑफिस | The operator's counter / owner | building | Admin, Back office |
| Owner | मालिक | Operator who runs the business | — | Admin, Tenant |
| Staff | स्टाफ़ | Counter worker | — | Operator user |
| Month | महीना | A billing period | calendar | Cycle, Period |

## Money

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Due | बाकी | Money the customer still owes | `semantic.due` (red text) | Outstanding, Arrears, बकाया राशि |
| Credit | एडवांस | Customer paid extra; used on the next bill | `semantic.credit` (green text) | Advance balance, Wallet, जमा |
| Amount | रकम | Any rupee value | — | Sum, राशि |
| Cash | नकद | Paid in notes / coins | banknote, `semantic.cash` (green) | नकदी |
| UPI | UPI | Paid by phone (GPay, PhonePe, Paytm…) | qr-code, `semantic.upi` (blue) | Online, Digital |
| Collect | पैसे लें | Take money from a customer | banknote | Receive payment, भुगतान प्राप्त करें |
| Payment | पेमेंट | One collection of money | — | Transaction, भुगतान |
| Hand over cash | ऑफिस को कैश दें | Lineman gives the day's cash to the office | building | Settlement, Deposit |
| Bill change | बिल में बदलाव | Extra charge or discount after a bill is made | — | Adjustment, Debit/credit note |
| Undo payment | पेमेंट रद्द करें | Owner-only correction with a reason (not a refund) | — | Reversal, Void, Refund |
| Make this month's bills | इस महीने के बिल बनाएँ | The monthly billing run | — | Billing run, Generate invoices |

Amounts are whole rupees with Indian grouping: `₹1,23,456`. Digits stay Latin (0–9) in Hindi too
(PLAN §11.4). Pass amounts to messages as pre-formatted text: `"₹{amount} due"` / `"₹{amount} बाकी"`.
Dates: `12 Oct 2026` / `12 अक्टू 2026`.

## States (say only what is true, BR-11/BR-12)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Saved on phone | फ़ोन में सेव | Stored on the phone, not yet at the office | clock, `semantic.pending` (amber) | Pending sync, Paid, Done |
| Sent to office | ऑफिस पहुँच गया | The server has confirmed it | check-circle, `semantic.success` (green) | Synced, Uploaded |
| Waiting | इंतज़ार में | Saved on phone, will be sent when there is internet | clock, `semantic.pending` (amber) | Queued, Pending |
| Problem | दिक्कत | Needs the office to look at it | alert-triangle, `semantic.danger` (red) | Error, Failed, Conflict |
| WhatsApp opened | WhatsApp खुल गया | We opened WhatsApp; we don't know if it was sent | — | Sent, Delivered, भेजा गया |
| SMS opened | SMS खुल गया | We opened the SMS app; we don't know if it was sent | — | Sent, Delivered |
| Shared | शेयर किया | The share sheet was used | — | Sent, Delivered |
| Active | चालू | Connection is on and is billed | — | Enabled |
| Stopped | बंद | Connection is off; rent stops from next month | — | Suspended, Deactivated |
| No internet | इंटरनेट नहीं है | Phone is offline | — | Network error |

Never say a WhatsApp/SMS message was "sent" or "delivered" (CLAUDE.md). Never show "Paid" before
the office has the payment.

## Actions (buttons)

| English | हिंदी | Icon |
|---|---|---|
| Save | सेव करें | check |
| Cancel | रद्द करें | x |
| Back | पीछे | arrow-left |
| Next | आगे | arrow-right |
| Done | हो गया | check |
| Try again | फिर से करें | refresh |
| Change | बदलें | pencil |
| Search | खोजें | search |
| Print | प्रिंट | printer |
| Share | शेयर करें | share |
| Call office | ऑफिस को फ़ोन करें | phone |
| Yes / No | हाँ / नहीं | — |
| OK | ठीक है | — |
| Sign in | लॉग इन करें | arrow-right |
| Sign out | लॉग आउट करें | log-out |
| Show / Hide (password) | दिखाएँ / छिपाएँ | eye / eye-off |
| Update app | ऐप अपडेट करें | download |
| Allow (a phone permission) | इजाज़त दें | circle-check |
| Find printer | प्रिंटर खोजें | search |
| Test print | टेस्ट प्रिंट | printer |

## Printer words (lineman app)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Printer | प्रिंटर | The small Bluetooth receipt printer | printer | Thermal printer, POS, मुद्रक |
| Bluetooth | ब्लूटूथ | How the phone talks to the printer | bluetooth | BT, Wireless |
| Paired | जुड़ा हुआ | The phone already knows this printer ("Printers on this phone") | — | Bonded, Connected |
| Paper | कागज़ | The printer's paper roll | — | Roll, Media |
| Temporary no. | अस्थायी नं. | A `P-…` receipt number before the office gives the final `R-…` one | clock, `semantic.pending` (amber) | Provisional, Draft |
| The printer got it | प्रिंटर को मिल गया | Every byte reached the printer; we cannot see the paper | check-circle, `semantic.success` | Printed successfully, Done |

## Sign-in words (lineman app)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| User name | यूज़र नेम | What the lineman types to sign in (usually their mobile number) | user | Login ID, Username/ID |
| Password | पासवर्ड | The secret the owner gave the lineman | lock | PIN, Passcode, कूटशब्द |
| Account | अकाउंट | The lineman's sign-in, which the owner can switch off | — | Profile, User |

## Sign-in words (web)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Email | ईमेल | Address the reset link is sent to (owners, staff) | — | E-mail ID, ई-मेल पता |
| Link | लिंक | The one-time address in the reset email | — | URL, Token |
| Forgot password? | पासवर्ड भूल गए? | Ask for a reset link | — | Recover account |
| Code | कोड | The 6-digit number from the authenticator app (admins) | — | OTP, TOTP, Token |
| 2-step sign-in | 2-स्टेप लॉग इन | Password + code (platform admins) | — | 2FA, MFA |
| Sign out on all devices | सभी डिवाइस से लॉग आउट करें | End every session of this user | log-out | Revoke sessions |

## Search and customer words (lineman app)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Customer list | ग्राहकों की लिस्ट | The customers copied to the phone for offline search | — | Roster, Sync data |
| Updated 5 min ago | 5 मिनट पहले अपडेट हुआ | When the phone last got the customer list | circle-check, `semantic.success` | Synced, Last sync |
| Payments on phone | फ़ोन में 3 पेमेंट | Payments saved on the phone, not yet at the office | clock, `semantic.pending` | Pending, Unsynced |
| Call (a customer) | फ़ोन करें | Opens the dialer with the customer's number | phone | Dial, कॉल करें |
| Connections | कनेक्शन | How many VC cards a customer has | tv | Subscriptions |
| Nothing due | कुछ बाकी नहीं | The customer owes nothing now | — | Paid, Cleared |

## Words we never show users

Invoice, Ledger, Allocation, Adjustment, Reversal, Tenant, Sync / Synced / Pending sync,
Transaction, Subscriber, Arrears, Settlement, Queue, Error code, and any English or Hindi word not
in this file when a listed one fits. Internal names in code (`invoice`, `allocation`, `tenant`) are
fine; only the words people read are covered here.

Exception: our own SaaS fee to the operator (Settings → Subscription) may say "Tax invoice" /
"टैक्स इनवॉइस", because that is the legal name of that document (H-10).
