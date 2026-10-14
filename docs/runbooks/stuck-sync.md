# Runbook: payments stuck on phones (stuck sync)

Alert: `sync-errors-spike`, or a call from an operator ("the lineman's payments don't show"). Background:
PLAN §10.4 and §9.2, T-061 (payment batch API), T-062 (Linemen page), T-066 (phone queue), T-071
(phone settings and app report).

**The one rule:** payments are never deleted from a phone (BR-11). Signing out, a revoked phone or a
password change never deletes them; the server accepts a re-sent payment only once (its id is the
idempotency key). So the fix is always "get the phone to send again", never "re-enter the payments by
hand" (that would make a second payment). Never ask a lineman to clear app data or reinstall.

What the lineman sees, and what it means:

| On the phone | Meaning |
|---|---|
| clock, amber: "Saved on phone" | not sent yet; the phone retries by itself |
| green tick: "Sent to office" | the server has it (it may be flagged for review: still safe) |
| red: "Call office" (`NEEDS_OFFICE_HELP`) | the server **rejected** it (malformed, another business). It stays on the phone |
| Waiting tab | everything not yet sent; **Try now** sends at once |

---

## 1. Server-side errors (alert: payment sync errors spike)

More than 10 Sentry exceptions tagged `endpoint=postPaymentBatch` in an hour: the server failed
(`retry_later`) while posting payments. The phones keep them and retry, so nothing is lost, but the
office doesn't see them.

1. Open the Sentry issue: the error type / SQLSTATE says what failed. Vercel logs:
   `mobile_api.payment_item_failed` (per item) and `mobile_api.payment_batch` (per request, with counts
   `posted`, `duplicate`, `posted_needs_review`, `rejected`, `retry_later`).
2. Common causes: Neon down or out of connections (status page; Neon → Monitoring), a bad deploy
   (rollback.md §1 if it started with a deploy), a migration that changed `payments` (fix forward).
3. After the fix, nothing else is needed: phones send again on their own (backoff), on app open, on
   each save, and with **Try now**. Watch the `retry_later` counts fall to 0 in the logs.
4. Optional: tell operators "Payments are safe on the phones and will reach the office by themselves."

## 2. One lineman's payments don't reach the office

1. **Web, Linemen page** (Owner/Staff, T-062): the lineman's day card warns "may still be on the
   phone" when the phone has not been in contact for 30 minutes after the day; the handover shows the
   phone's own count of unsent payments.
2. **Settings → Team → the lineman's phones** (Owner, T-032): model, app version, last seen, signed in or out.
3. Ask the lineman (in simple words) to open the app, look at **Waiting**, and press **Try now** with
   mobile data or Wi-Fi on. Then:

| What happens | Cause | Fix |
|---|---|---|
| The count goes down to 0 | the phone had no internet, or Android delayed the background send (battery saver) | done. If it happens daily: Android settings → Battery → the app → "Unrestricted" (varies by phone maker) |
| The app asks to sign in | the sign-in ran out or was ended ("Sign out this phone", new password, switched off) | the **same** lineman signs in again; the payments then go. A **different** lineman signing in leaves them held (§3) |
| a screen asking to update the app | the phone's app is below the minimum version (`APP_TOO_OLD`) | update from the Play Store; the queue survives the update |
| Account switched off | `ACCOUNT_DISABLED` | the Owner switches the lineman back on (Team), lets the phone send, then switches off again if wanted. Payments are never lost meanwhile |
| Still stuck, phone online | unknown | Settings → **Share app report** (no personal data) and send it to support; check the Vercel logs for that time (`mobile_api.*`, by `operator_id`) |

## 3. Payments held after a different lineman signed in

If someone else signs in on a phone that still holds the first lineman's payments, those payments stay
**held** on the phone (PLAN §9.2): they are not sent under the wrong name. Fix: the first lineman signs
in on that phone again, presses **Try now**, then signs out; then the second lineman signs in. (If the
first lineman has left: open question raised by T-066, decision pending; until then keep the phone
and call support.)

## 4. "Call office" (rejected) payments

The server refused the payment as invalid (`rejected`): for example a customer of another business or
a damaged record. It stays on the phone, marked red.

1. Vercel logs at that time: `mobile_api.payment_batch` with `rejected > 0`; the response error code
   says why (`VALIDATION`, `CUSTOMER_NOT_FOUND`, …). Find the operator via `operator_id`.
2. If the money was really taken, the Owner records it as a counter payment (Payments → New) with a
   note "phone payment refused, receipt P-…", **only after** confirming the phone's payment can never
   be accepted (a rejected payment is not retried automatically). Ask the lineman for the provisional
   receipt number (`P-…`).
3. A pattern of rejections (several phones) is a bug: open an incident.

## 5. Payments sent, but flagged "to check"

`posted_needs_review` is not a sync problem: the money reached the office and counts, but something was
odd (customer switched off, lineman switched off, a different phone, a clock far off). The Owner reviews
them in **Payments to check** (`/payments/review`) and marks them resolved. Nothing to do here unless
there are many (`SELECT review_reason, count(*) FROM payments WHERE review_status = 'needs_review' GROUP BY 1`):
many `recorded_at_out_of_range` = phones with a wrong clock; many `device_mismatch` = shared phones.
