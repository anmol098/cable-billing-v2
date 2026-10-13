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

## Sign-up words (web)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Create account | अकाउंट बनाएँ | An owner signs up for Cable Billing | — | Register, Sign up, रजिस्टर करें |
| 30 days free | 30 दिन मुफ़्त | The free trial (D-20) | — | Trial, ट्रायल, Free tier |
| Business name | बिज़नेस का नाम | The operator's name, as customers know it | — | Company, Tenant, फ़र्म |
| Mobile no. | मोबाइल नंबर | The owner's 10-digit mobile number | phone | Phone number, Contact |
| Confirm (an email) | पक्का करें | Open the link we emailed, to show the email is yours | — | Verify, Validate, सत्यापित करें |
| Check that you are a person | जाँच कि आप इंसान हैं | The anti-robot box on the form | — | CAPTCHA, Bot check |
| Start | शुरू करें | Begin using the app after confirming the email | arrow-right | Activate, Provision |

## Search and customer words (lineman app)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Customer list | ग्राहकों की लिस्ट | The customers copied to the phone for offline search | — | Roster, Sync data |
| Updated 5 min ago | 5 मिनट पहले अपडेट हुआ | When the phone last got the customer list | circle-check, `semantic.success` | Synced, Last sync |
| Payments on phone | फ़ोन में 3 पेमेंट | Payments saved on the phone, not yet at the office | clock, `semantic.pending` | Pending, Unsynced |
| Call (a customer) | फ़ोन करें | Opens the dialer with the customer's number | phone | Dial, कॉल करें |
| Connections | कनेक्शन | How many VC cards a customer has | tv | Subscriptions |
| Nothing due | कुछ बाकी नहीं | The customer owes nothing now | — | Paid, Cleared |

## Menu words (web)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Home | होम | The first page after sign-in | house | Dashboard, डैशबोर्ड |
| Reports | रिपोर्ट | Lists and totals to check the business | chart-column | Analytics, MIS |
| Settings | सेटिंग | Business details, plans, areas, team | settings | Configuration, Admin |
| More | और | The rest of the menu on a phone | ellipsis | Menu, ☰ alone |
| Bill changes | बिल में बदलाव | List of extra charges / discounts after bills | pencil | Adjustments |
| Payments to check | जाँचने वाले पेमेंट | Payments the office must look at | alert-triangle | Review queue, Exceptions |
| Download data | डेटा डाउनलोड करें | Owner takes the data out as a file | download | Export, CSV |
| Who changed what | किसने क्या बदला | The record of every change | rotate-ccw-clock | Audit log, ऑडिट |
| App subscription | ऐप सब्सक्रिप्शन | Our monthly fee for Cable Billing | credit-card | Plan (that word is the customer's rental), Billing |
| Coming soon | जल्द आ रहा है | A page that is not built yet | — | Under construction, WIP |

## Collect words (lineman app)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| How much money? | कितने पैसे? | The Amount screen's question | — | Enter amount, राशि दर्ज करें |
| Full due | पूरा बाकी | Quick amount: everything the customer owes now | — | Outstanding, Total dues |
| How did they pay? | पैसे कैसे दिए? | The Method screen's question (Cash / UPI) | banknote / qr-code | Payment mode |
| UPI ref no. | UPI रेफ़. नं. | The number the customer's UPI app shows; optional, not proof | — | UTR, Transaction ID |
| Skip | छोड़ें | Go on without typing the optional UPI ref | arrow-right | Not applicable, N/A |
| Check and save | देखें और सेव करें | The Confirm screen before money is saved | check | Review, Submit |
| Money saved | पैसे सेव हो गए | Done screen title: saved on the phone (never "paid" or "sent") | check-circle | Payment successful |
| Try now | अभी भेजें | Waiting screen: send what is on the phone to the office now | arrow-right | Sync, Retry upload |
| Other lineman | दूसरा लाइनमैन | A payment another lineman saved on this phone; held, not sent with your sign-in | alert-triangle, `semantic.danger` | Foreign queue, Held items |

## Public pages (web, T-087)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Price | कीमत | Our monthly fee, on the public pages | — | Pricing, Plan (that word is the customer's rental), दाम |
| Free trial | फ़्री ट्रायल | The first 30 days after sign-up, no payment | — | Demo, निःशुल्क परीक्षण |
| Start free trial | फ़्री ट्रायल शुरू करें | Go to sign-up | arrow-right | Get started, Register |
| Sign up | साइन अप | Create the business's account | — | Register, पंजीकरण |
| Open app | ऐप खोलें | Header link when already signed in (goes through sign-in) | — | Dashboard, Go to console |
| View only | सिर्फ़ देख सकते हैं | Read-only mode after an unpaid fee (collections still work) | — | Read-only, Suspended |
| Unlimited customers | ग्राहक जितने चाहें | No limit on how many customers | — | असीमित ग्राहक |
| Privacy policy | प्राइवेसी पॉलिसी | What data we keep and why | — | Data policy, गोपनीयता नीति |
| Terms of use | इस्तेमाल की शर्तें | How the service works and what to expect | — | T&C, नियम और शर्तें |
| Contact us | हमसे बात करें | Support email / phone page | email, phone | Support, संपर्क करें |
| Draft | ड्राफ़्ट | Text not yet checked by a lawyer | clock, `semantic.pending` (amber) | Beta, प्रारूप |

## Cash handover words (web Linemen page)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Cash expected | कितना कैश होना चाहिए | Cash payments the office has for the lineman's day (UPI and cancelled payments not counted) | banknote, `semantic.cash` | Expected collection, System total |
| Cash handed over | कितना कैश दिया | The cash the lineman gave the office | handshake | Deposit, Settlement |
| ₹50 short / ₹50 extra | ₹50 कम / ₹50 ज़्यादा | Handed over minus expected | `semantic.danger` (red) | Discrepancy, Variance |
| Cash matches | कैश पूरा है | Handed over = expected | `semantic.success` (green) | Reconciled, Balanced |
| Not handed over | कैश नहीं दिया | No handover for the day yet | clock, `semantic.pending` | Open, Pending |
| Waiting for check | जाँच बाकी | Handed over; the office has not decided | handshake, `semantic.pending` | Submitted, Pending review |
| Accept / Accepted | मंज़ूर करें / मंज़ूर | The office takes the cash; the day is closed | circle-check, `semantic.success` | Approve, Reconcile |
| Send back / Sent back | वापस भेजें / वापस भेजा | The office returns the handover with a note; the lineman hands over again | undo, `semantic.danger` | Reject, Return |
| Phone last online | फ़ोन आख़िरी बार ऑनलाइन | When the lineman's phone last reached the office | phone | Last sync, Last seen |
| Cancelled (a payment) | रद्द | A payment the owner undid; not in the totals | `semantic.danger` | Reversed, Void |
| Switched off (a lineman) | बंद | A deactivated lineman's account | — | Disabled, Inactive |

## Customer words (web)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Customer code | ग्राहक कोड | The number or code people know a customer by (`1045`, `A-101`) | — | Account no., ID, Subscriber ID |
| Next number | अगला नंबर | The code the app gives when the code box is left empty | — | Auto-generated, Sequence |
| Other mobile no. | दूसरा मोबाइल नंबर | A second number for the same customer | phone | Alternate contact, Secondary phone |
| Closed (customer) | बंद | The customer left; kept for old bills and payments, gets no new bills | x, grey | Deactivated, Deleted, Inactive |
| Make active again | फिर से चालू करें | Undo "Closed" | check-circle | Reactivate, Restore |
| Removed (connection) | हटाया गया | A connection that ended for good (the VC can go to another customer) | — | Disconnected, Terminated |
| Change details | जानकारी बदलें | Edit a customer's name, numbers, area, address | pencil | Edit profile, Update record |
| Summary | सारांश | The first tab of a customer: due, connections, last payment | — | Overview, Dashboard |
| Unpaid since | … से बाकी | The oldest month that is still not fully paid | `semantic.due` (red text) | Overdue since, Ageing |
| Own amount | अपनी रकम | A connection's monthly rent typed by hand instead of a plan | — | Custom rental, Override |

## Words we never show users

Invoice, Ledger, Allocation, Adjustment, Reversal, Tenant, Sync / Synced / Pending sync,
Transaction, Subscriber, Arrears, Settlement, Queue, Error code, and any English or Hindi word not
in this file when a listed one fits. Internal names in code (`invoice`, `allocation`, `tenant`) are
fine; only the words people read are covered here.

Exception: our own SaaS fee to the operator (Settings → Subscription) may say "Tax invoice" /
"टैक्स इनवॉइस", because that is the legal name of that document (H-10).
