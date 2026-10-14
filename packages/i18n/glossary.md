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

## Settings words (lineman app)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Settings | सेटिंग | The low-traffic options screen (gear on the search home) | settings | Preferences, Options, सेटिंग्स |
| Language | भाषा | हिंदी or English for the whole app | languages | Locale |
| Voice | आवाज़ | The read-out (on / off) | volume-2 / volume-x | TTS, Speech |
| App version | ऐप वर्ज़न | `0.1.0 (1)` | — | Build |
| App report | ऐप रिपोर्ट | Diagnostic log the lineman shares for support (no customer data) | share-2 | Diagnostics, Logs, Crash report |
| Share app report | ऐप रिपोर्ट शेयर करें | Opens the share sheet; we never know if it went anywhere | share-2 | Send diagnostics, Upload |

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

## Settings words (web)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Business details | बिज़नेस की जानकारी | Settings page: name, office phone, address, receipt words | store | Business profile, Company settings |
| Office phone | ऑफिस का फ़ोन | Number on receipts and on the linemen's "Call office" button | phone | Helpline, Contact no. |
| Receipt message | रसीद पर संदेश | Words printed at the bottom of every receipt | — | Footer, Receipt footer |
| Bill number start | बिल नंबर की शुरुआत | The letters before every new bill number (`CB-2610-00001`) | — | Invoice prefix, Series |
| Receipt language | रसीद की भाषा | Language of the receipt link customers open | languages | Default locale |
| Charge the full month | पूरे महीने का पैसा लें | Mid-month start: this month's full rent goes on the next bill (D-18) | receipt | Prorate, Adjustment |
| Start from next month | अगले महीने से शुरू करें | Mid-month start: no rent for this month (D-18) | arrow-right | Defer billing |
| Hide (an area) | छिपाएँ | Take an area out of the pickers; its customers keep it | eye-off | Archive, Delete, Deactivate |
| Show again | फिर से दिखाएँ | Put a hidden area back in the pickers | eye | Restore, Unarchive |
| Hidden | छिपा हुआ | An area that is not offered for new customers | eye-off | Archived, Inactive |

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

## Today and cash handover words (lineman app, T-070)

The office's words for a handover (Cash expected, Waiting for check, Accepted, Sent back, ₹50 short /
extra, Cash matches, Not handed over) are the ones in the web table above; the phone uses the same.

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Today | आज | The lineman's India-time day: cash and UPI on separate tiles, never one total | calendar-days | Daily summary, Session |
| At the office | ऑफिस में | The office's own numbers for the day (payments it has) | circle-check, `semantic.success` | Server total, Synced |
| Only on the phone | सिर्फ़ फ़ोन में | Payments of the day the office does not have yet | clock, `semantic.pending` | Unsynced, Pending |
| Counted on this phone | इस फ़ोन में गिना | Totals made from the phone's payments when the office has not answered | clock, `semantic.pending` | Local totals, Offline data |
| How much cash are you giving? | कितना कैश दे रहे हैं? | The handover's number-pad question | handshake | Enter amount, Deposit amount |
| Why is it different? | फ़र्क क्यों है? | The reason question when the cash differs | — | Discrepancy reason |
| Less cash / More cash | कैश कम है / कैश ज़्यादा है | Reason tiles for short / extra cash | circle-minus / circle-plus | Shortage, Excess |
| Payments on phone | पेमेंट फ़ोन में हैं | Reason tile: some payments have not reached the office yet | clock | Pending sync |
| Other reason | कुछ और | Reason tile: anything else (say it in the note) | pencil | Miscellaneous |
| Note (not needed) | नोट (ज़रूरी नहीं) | Optional words with the handover (the keyboard's mic works) | — | Remarks, Comments |
| Hand over again | फिर से कैश दें | A new handover after "Sent back" (or to correct one) | handshake | Resubmit |
| Check again | फिर से देखें | Ask the office again whether it checked the handover | arrow-right | Refresh, Reload |

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

## Team words (web Settings → Staff and linemen)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Add lineman / Add staff | लाइनमैन जोड़ें / स्टाफ़ जोड़ें | Owner creates a sign-in for a person | plus | Create user, Invite member |
| User name | यूज़र नेम | What they type to sign in (usually the mobile number) | — | Login ID, Username |
| Make one for me | मेरे लिए बना दें | Fill in a random 6-digit password | lock | Generate, Auto-generate |
| New password | नया पासवर्ड | Owner sets a new password; their phone/website signs out | lock | Reset credentials |
| Share sign-in on WhatsApp | लॉग इन WhatsApp पर शेयर करें | Opens WhatsApp with the app link and user name (never the password) | message-circle | Send login, Invite |
| Switch off / Switch on | बंद करें / चालू करें | Stop / allow a person to sign in; nothing is deleted | user-x / user-check | Deactivate, Disable, Delete |
| Active | चालू | The person can sign in | circle-check, `semantic.success` | Enabled |
| Signed in / Signed out (a phone) | लॉग इन है / लॉग आउट है | Whether the phone still holds a working sign-in | circle-check / log-out | Session active, Revoked |
| Sign out this phone | इस फ़ोन से लॉग आउट करें | Owner ends a lost phone's sign-in; payments on it stay on it | log-out | Revoke device, Remote wipe |
| Has not set a password yet | अभी पासवर्ड नहीं बनाया | Staff invited by email who have not used the link | clock, `semantic.pending` | Pending invite |
| Email them a link | उन्हें ईमेल पर लिंक भेजें | Staff set their own password from an email | mail | Send invite |

## Bills words (web Bills pages)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Make bills now | अभी बिल बनाएँ | Owner starts the month's bill run | receipt | Run billing, Generate invoices |
| Preview (this month) | पहले देखें | What making bills would do, nothing saved | eye | Dry run, Simulation |
| Bills made | बिल बन गए | The month's run finished | check-circle, `semantic.success` | Completed, Success |
| Making bills | बिल बन रहे हैं | The run is working in the background | clock, `semantic.pending` | Running, Processing, Queued |
| Some problems | कुछ में दिक्कत | The run finished but some customers got no bill | alert-triangle, `semantic.danger` | Completed with errors, Failed items |
| Missed | छूट गया | The month's bills were not made while the app was view-only | alert-triangle, `semantic.danger` | Skipped |
| Missed bill runs | छूटे हुए महीनों के बिल | Months to check and make by hand after paying again | alert-triangle | Catch-up, Backlog |
| Try problems again | दिक्कत वाले फिर से करें | Owner retries only the customers with a problem | refresh | Retry failed items |
| All bills | सारे बिल | The list of a month's bills | receipt | Bill register, Invoice list |
| Not paid / Part paid / Paid | नहीं भरा / कुछ भरा / पूरा भरा | How much of one bill is paid | alert-triangle / clock / check-circle | Unpaid, Partially allocated, Settled |
| Monthly rent | महीने का किराया | A connection's rent line on a bill | tv | Rental charge, Subscription fee |
| Old due | पुराना बाकी | What the customer owed before this bill | `semantic.due` | Opening balance, Arrears |
| Still due on this bill | इस बिल पर बाकी | This bill's charges not yet paid | `semantic.due` | Outstanding |
| Print bill | बिल प्रिंट करें | The A5 paper bill, in the operator's language | printer | Export PDF, Invoice copy |

## Connection words (web, T-034)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Rent (monthly) | किराया | What a connection costs each month (its plan or own amount) | — | Rental, Tariff, Subscription fee |
| Stop (a connection) | बंद करें | Pause it; rent stops from the next month; it can be started again | circle-pause | Suspend, Deactivate |
| Start again | फिर से चालू करें | Undo "Stop"; rent starts again from the next month | circle-play | Reactivate, Resume |
| Remove (a connection) | हटाएँ | End it for good; the VC can go to another customer from the next day | unplug | Disconnect, Terminate, Delete |
| Add connection | कनेक्शन जोड़ें | Put a set-top box (VC number) on a customer | plus | Assign VC, New subscription |
| Start day | शुरू का दिन | The day the box was put in | calendar | Activation date, Start date |
| From which day? | किस दिन से? | The day a stop / start / removal counts from | calendar | Effective date |
| Old due stays | पुराना बाकी रहेगा | Money already owed is not changed by a stop or removal | `semantic.due` (red text) | Arrears remain |
| Old connections | पुराने कनेक्शन | Removed connections, kept with their old bills and payments | — | History, Archived |
| What happened | क्या हुआ | A connection's list of starts, stops, rent changes and removal | — | Timeline, Audit trail, Events |

## Payment words (web counter and payments list)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Take payment | पैसे लें | The office takes money at the counter | banknote | Record payment, Receive payment |
| Who is paying? | कौन पैसे दे रहा है? | The counter's first step: find the customer | person | Select customer |
| Counted | गिना गया | A payment that counts (not cancelled) | check-circle, `semantic.success` | Posted, Valid |
| To check / Payments to check | जाँचना है / जाँचने वाले पेमेंट | A payment that came in with something odd; the money is saved, the office looks at it | alert-triangle, `semantic.pending` | Needs review, Flagged, Exception |
| Mark as checked / Checked | जाँच हो गई | The office has looked at a payment to check | circle-check, `semantic.success` | Resolve, Approve |
| Taken by | किसने लिया | The person who took the money | — | Collector, Agent |
| Money taken / Reached the office | पैसे कब लिए / ऑफिस कब पहुँचा | The phone's time of the payment / when the server got it | — | Recorded at / Posted at |
| Temporary no. (phone's) | (फ़ोन का) अस्थायी नं. | The phone's receipt no. `P-…` before the office number | — | Provisional reference |
| Print receipt (A5) | रसीद प्रिंट करें (A5) | Opens the A5 receipt to print at the office | printer | Generate PDF |
| Copy receipt link / Link copied | रसीद का लिंक कॉपी करें / लिंक कॉपी हो गया | Copies the receipt link to paste in WhatsApp or SMS; we never know if it was sent | share | Send receipt, Sent |
| Wrong customer / Wrong amount / Saved twice / Money not received / Other reason | गलत ग्राहक / गलत रकम / दो बार सेव हुआ / पैसे नहीं मिले / कोई और वजह | Why the owner undoes a payment | undo | Error type |
| Balance now | अब का हिसाब | What the customer owes (or has as credit) now | — | Outstanding balance, Ledger balance |

## Account history words (web customer History and Bills tabs)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Account history | खाते का हिसाब | Every bill, payment, cancelled payment and discount of a customer, with the balance after each | rotate-ccw-clock | Ledger, Statement of account, खाता बही |
| Account statement | खाते का हिसाब | The printed / saved-as-PDF account history for chosen days | printer | Ledger report, Statement |
| Balance | हिसाब | Due or credit right after a line (says "Due" / "Credit", never a minus sign) | `semantic.due` / `semantic.credit` | Running balance, Closing balance, शेष |
| Balance before {date} | {date} से पहले का हिसाब | What the customer owed (or had as credit) when the chosen days start | — | Opening balance, B/F |
| Extra charge | एक्स्ट्रा चार्ज | A bill change that adds money | pencil | Debit adjustment, Debit note |
| Discount | छूट | A bill change that takes money off (it becomes credit) | pencil | Credit adjustment, Credit note, Rebate |
| Payment cancelled / Cancelled later | पेमेंट रद्द / बाद में रद्द | The Owner undid a payment; the money is owed again | undo, `semantic.danger` | Reversal, Refund, Void |
| Old dues from your old records | पुराने रिकॉर्ड से पुराना बाकी | Dues brought in from the operator's old software | receipt | Opening balance invoice, Migration |
| Money taken on {date} | पैसे {date} को लिए | The day the lineman took the money, when the office got it later | — | Recorded at, Business date |
| Which days? / This month / Last 3 months / Last 12 months / Everything | कौन से दिन? / इस महीने / पिछले 3 महीने / पिछले 12 महीने / सब कुछ | The time choice above the account history | calendar-days | Period, Date range, Filter |

## Receipt words (lineman app, T-069)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Customer's mobile number | ग्राहक का मोबाइल नंबर | The number the receipt goes to; confirmed before every WhatsApp/SMS receipt (FR-004) | — | Contact, MSISDN |
| Yes, this number | हाँ, यही नंबर | Confirm the shown number | check-circle, green | Confirm, Verify |
| Change number | नंबर बदलें | Type another number on the pad (the office gets the change) | pencil | Edit contact |
| Receipt link | रसीद का लिंक | The online receipt page the customer opens | — | URL, Preview link |
| The link will be ready when there is internet | इंटरनेट आने पर लिंक तैयार होगा | The link is asked for and comes by itself later | clock, `semantic.pending` (amber) | Pending sync, Queued |
| Open WhatsApp / Open SMS | WhatsApp खोलें / SMS खोलें | Opens the chat / SMS app with the message ready; the lineman presses Send there | whatsapp / message | Send, भेजें |
| Share PDF | PDF शेयर करें | Hands the receipt PDF to WhatsApp or the share sheet | share | Send PDF, Export |
| PDF shared | PDF शेयर किया | We handed the PDF over; we don't know if it was sent | check-circle | Sent, Delivered |

The receipt flow never uses "send / sent / delivered" (भेजें, भेजा गया, डिलीवर): the app only knows
that it opened another app (RULE-19). `HonestReceiptWordsTest` checks every `mobile_receipt` string.

## Plan words (web Settings → Plans, T-031)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Rent each month | हर महीने का किराया | A plan's monthly amount (whole rupees) | — | Price, Tariff, MRP, Rate |
| Change (a plan) | बदलें | Change a plan's name or rent | pencil | Edit, Modify |
| Save new rent | नया किराया सेव करें | Confirm a plan's new rent; its connections keep the old rent, bills already made never change | circle-check | Apply price, Update tariff |
| Hide (a plan) | छिपाएँ | Stop offering a plan for new connections; its connections keep it and their rent | eye-off | Retire, Archive, Delete, Deactivate |
| Show again (a plan) | फिर से दिखाएँ | Offer a hidden plan again | eye | Unretire, Restore |
| Hidden (a plan) | छिपा हुआ | A plan not offered for new connections | eye-off | Retired, Inactive |

## Subscription words (web Settings → App subscription, T-085)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Free trial | फ़्री ट्रायल | Status: the first 30 days, nothing to pay | clock, `semantic.pending` | Trialing, Demo |
| Paid | पेमेंट हो गया | Status: this month's fee is paid | check-circle, `semantic.success` | Active, Subscribed |
| Pay now | अभी पेमेंट करें | Status and button: the fee is due, the app still works fully (grace) | clock, `semantic.pending` | Grace period, Overdue |
| View only | सिर्फ़ देख सकते हैं | Status: unpaid after grace; looking and collecting money still work | alert-triangle, `semantic.danger` | Read-only, Suspended, Locked |
| Stopped | बंद है | Status: autopay was cancelled and the paid time is over | alert-triangle, `semantic.danger` | Cancelled, Terminated |
| Pay ₹472 a month | ₹472 महीना पेमेंट करें | The one button that opens Razorpay | credit-card | Subscribe, Checkout, Buy plan |
| Autopay | ऑटोपे | Razorpay takes the fee every month by itself (UPI Autopay or card) | — | Mandate, e-NACH, Recurring billing |
| Paid till 13 Dec | 13 दिस तक का पेमेंट हो गया | The last day this month's fee covers (IST) | — | Valid until, Expiry |
| Payment was not finished | पेमेंट पूरा नहीं हुआ | Checkout was closed before paying (never "failed") | clock, `semantic.pending` | Payment failed, Declined |

## Report words (web Reports pages)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Numbers as of {time} / as of the end of {day} | {time} तक के आँकड़े / {day} का दिन खत्म होने तक के आँकड़े | The moment a report's numbers are from; later payments and bills are not in them | calendar | Snapshot, Report date, Generated at |
| Due list | बाकी की लिस्ट | Who owes money, how much and since when | chart-column | Outstanding report, Receivables, Ageing report |
| How old (0–30 days / 31–60 days / 61–90 days / Over 90 days) | कितना पुराना (0–30 दिन / … / 90 दिन से ज़्यादा) | Days since the 1st of the bill's month; credit pays the oldest bills first | clock (amber) up to 60 days, alert-triangle (red) after | Ageing bucket, Overdue, DPD |
| Due minus credit | बाकी में से एडवांस घटाकर | What all customers owe together (= their accounts) | `semantic.due` / `semantic.credit` | Net receivable, Ledger balance |
| Customers with credit | जिनका एडवांस है | Customers who paid more than their bills | `semantic.credit` | Advance customers, Negative balance |
| Total (totals row) | कुल | The sum of every row that matches the filters, not only this page | — | Grand total, Subtotal |

## Bill change words (web, T-045)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Change plan | प्लान बदलें | Give a connection a new plan or own amount from a day | tv | Upgrade/downgrade, Modify subscription |
| Change from an earlier day | पहले की तारीख से बदलें | Owner's change dated into a month whose bills are made; makes a bill change for each month | pencil | Back-date, Retroactive change |
| What happens to the bills | बिलों पर क्या असर होगा | The effect, month by month, shown before saving | — | Preview, Impact |
| ₹50 extra (will be added to the next bill) | ₹50 ज़्यादा (अगले बिल में जुड़ेगा) | A bill change that adds to what is owed | `semantic.due` (red text) | Debit, Debit note |
| ₹50 less / Taken off | ₹50 कम / घटा दिया | What a discount (or a plan change down) does: money taken off what is owed | `semantic.credit` (green text) | Credit note, Refund |
| Extra charge / Discount | एक्स्ट्रा चार्ज / छूट | The two kinds of the Owner's own bill change (same words as the account history) | plus / undo | Debit / Credit |
| Next bill (waiting) | अगला बिल | An extra charge not yet on a bill | clock, `semantic.pending` | Pending, Unbilled |
| Why? | क्यों? | The reason the Owner writes for a bill change | — | Remarks, Justification |

## Home words (web Home page)

| English | हिंदी | Means | Icon / colour | Not this |
|---|---|---|---|---|
| Cash today / UPI today | आज नकद / आज UPI | Money taken today (IST day), cash and UPI apart; undone payments left out | banknote `semantic.cash` / qr-code `semantic.upi` | Today's collection, Revenue |
| Bills made | बिल बने | Σ of this month's bills | receipt-text | Billed amount, Invoiced |
| Money taken | पैसे मिले | Σ of this month's payments (cash + UPI) | hand-coins | Collected, Receipts, Realised |
| Total due | कुल बाकी | What all customers owe now (customers with credit count 0) | chart-column, `semantic.due` | Outstanding, Receivables, AR |
| To check | जाँचना है | Things the office should look at: handovers, payments to check, missed bills, the free trial | triangle-alert / handshake | Alerts, Notifications, Exceptions |
| Free trial: {n} days left | फ़्री ट्रायल: {n} दिन बाकी | Days until the free trial ends (Owner only) | credit-card, `semantic.pending` | Trial expiry, Subscription status |
| Scan this with the lineman's phone | लाइनमैन के फ़ोन से यह QR स्कैन करें | The QR code that opens the app on Google Play | qr-code | Download APK, Install link |

## Words we never show users

Invoice, Ledger, Allocation, Adjustment, Reversal, Tenant, Sync / Synced / Pending sync,
Transaction, Subscriber, Arrears, Settlement, Queue, Error code, and any English or Hindi word not
in this file when a listed one fits. Internal names in code (`invoice`, `allocation`, `tenant`) are
fine; only the words people read are covered here.

Exception: our own SaaS fee to the operator (Settings → Subscription) may say "Tax invoice" /
"टैक्स इनवॉइस", because that is the legal name of that document (H-10).
