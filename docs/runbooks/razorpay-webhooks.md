# Runbook: Razorpay subscription webhooks

Alert: `razorpay-webhook-failed` (Sentry exception tagged `webhook=razorpay`). Background: PLAN §13,
T-085 (`POST /api/webhooks/razorpay`, the daily `subscription-states` cron), environments.md §4.7.
This is **our** SaaS fee only (D-12); cable customers' payments never go through Razorpay.

## How it fits together

Razorpay calls the webhook for subscription events. The app checks the HMAC signature, stores the event
once (`subscription_events`, unique `razorpay_event_id`), and moves the tenant's subscription
(trialing → active → grace → read-only, D-13/D-20) in one transaction. If anything throws, the
transaction rolls back and the app answers **500**; Razorpay retries, and the daily
`subscription-states` cron (06:00 IST) also asks Razorpay's API about tenants near renewal, so a lost
webhook is caught within a day.

| Response | Meaning | Alert? |
|---|---|---|
| 200 | applied, duplicate, or a signed event we can't match (stored with `processing_error`) | no |
| 401 | bad signature: the secret in Razorpay ≠ `RAZORPAY_WEBHOOK_SECRET` | no (log `razorpay.webhook_bad_signature`) |
| 400 / 413 | no event id / body over 256 KB | no |
| 503 | `RAZORPAY_WEBHOOK_SECRET` not set | no |
| 500 | an error while applying | **yes** |

## A webhook failed

1. Sentry issue → the error type; Vercel logs `razorpay.webhook_failed` at that time (ids only).
2. Razorpay Dashboard → Settings → Webhooks → the webhook → delivery log: is it still retrying? It
   retries failed deliveries for a while, then disables the webhook after repeated failures; re-enable
   it there after the fix.
3. Fix the cause (Neon reachable? a deploy? rollback.md §1). Retries then succeed by themselves.
4. If a tenant paid but still shows grace or view-only: call the daily cron by hand, which reconciles
   with Razorpay's API:
   `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<production host>/api/cron/subscription-states`.
   As a last resort the platform admin can extend the subscription by hand (admin console, T-086;
   audited).
5. Many **401**s (no alert, but the Owner's page stays "not paid"): the webhook secret differs; set the
   same value in Razorpay and Vercel and redeploy (environments.md §7).
6. Signed events stored as `unmatched_subscription` / `operator_mismatch`
   (`SELECT processing_error, count(*) FROM subscription_events WHERE processing_error IS NOT NULL GROUP BY 1`):
   an event for a subscription we don't know. One-offs are harmless; a stream means the live webhook
   points at the wrong environment.
