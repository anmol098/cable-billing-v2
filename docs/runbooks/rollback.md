# Runbook: rollback

Who this is for: the engineer on call. How to undo a bad web deploy, a bad migration, bad data, a bad
Android release, a bad configuration change, and (pointer) the cutover. BRD §15 asks for a validated
rollback plan before go-live; PRD §19 phase 5 ("rollback plan validated").

Pick the smallest undo that stops the harm. Money is append-only: nothing here edits a payment, bill,
allocation or ledger entry by hand.

---

## 1. A web deploy is bad (Vercel)

Symptoms: errors in Sentry right after a deploy, `/api/health` failing, a broken page.

1. Vercel → project → Deployments → the last good **Production** deployment → **Instant Rollback**
   (or "Promote to Production"). It takes seconds; no build.
2. **Check the database is compatible.** Instant Rollback brings back old code, not an old database.
   If the bad deploy came with a migration (see `packages/db/migrations/` in its commits), the old code
   must still work with the new schema. That is why migrations should be **additive first** (new
   columns nullable or defaulted, new tables; removals only in a later release): then the old code
   keeps working. This rule is proposed here (T-096) for reviewers to apply; it is not enforced by a
   tool. If the migration was not additive, go to §2 before rolling back.
3. **Environment variables:** a rolled-back deployment keeps the variables it was built with. If a
   secret was rotated since (for example `cb_app` → `cb_app_v2`, environments.md §4.12 step 5), the
   old deployment may not connect: redeploy the old **commit** instead (Deployments → … → Redeploy),
   which picks up the current variables.
4. Crons run against whatever is in Production; nothing else to do. Phones keep working (the mobile
   API is versioned, `/api/mobile/v1`).
5. Revert the bad commit on `main` in a PR (so the next deploy doesn't bring it back), and write the
   incident note.

## 2. A migration is bad

Migrations run as the owner from the gated GitHub workflow, never from the Vercel build (PLAN §17).

- **It failed half-way:** check what is recorded: `SELECT id, hash, created_at FROM
  drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3;` and whether the objects exist
  (`\d table`). Fix the migration file **only if it never applied anywhere** (it is not in the journal
  of any database); otherwise write a new migration that completes or undoes it. Never edit a
  migration that is already on `feature/mvp` or applied in production (tasks/README.md §6).
- **It applied and broke the app:** prefer a **forward fix** (a new migration that restores what the
  code needs: re-add a column, restore a constraint). Then deploy.
- **It damaged data** (a bad backfill, a dropped column with data): rewind with Neon point-in-time
  restore to just before the migration (backup-and-restore.md §3), then deploy code that matches that
  schema. Everything written after that moment is lost and must be re-entered: weigh that first.

## 3. Bad data was written (any tenant)

- One operator's numbers are wrong because of a bug: fix the bug, then correct with **reversals and
  adjustments** (invariant-breach.md §4). This keeps the history.
- Wide damage, many tenants: point-in-time restore (backup-and-restore.md §3).
- Older than the Neon history window: restore a nightly dump into a **scratch** database (§4 there),
  read the old values, and correct production with reversals/adjustments. Never copy rows from a dump
  into production by hand.

## 4. An Android release is bad

Play cannot downgrade a phone that already has the new version.

1. Play Console → the app → Release → the track → **Halt rollout** (staged rollouts, PLAN §18 Phase 6)
   so no more phones get it.
2. Fix and release a build with a **higher versionCode**, then resume the rollout. Payments saved on
   phones survive app updates (Room, never destructive migrations, T-064).
3. **Never raise the minimum app version** (`MIN_APP_VERSION_CODE` in `apps/web/src/lib/mobile/config.ts`)
   to a broken build; if it was raised, lower it and redeploy the web app, so phones that didn't take
   the bad build keep working. Phones below the minimum see the update screen; their payments are kept
   and sent after updating.
4. Android crashes go to the `cable-billing-android` Sentry project (T-071); the app report (Settings →
   Share app report) helps with one phone.

## 5. A configuration or secret change is bad

Vercel applies variables only to new deployments. Put the previous value back (password manager entry,
environments.md §7) and **redeploy**. For the database role use the rotation steps in environments.md
§4.12 (old and new roles can run side by side). Razorpay webhook secret: change it in Razorpay and
Vercel together.

## 6. The cutover

Before the go-live point, the legacy system is untouched and only read-only: rollback = make it
writable again. After go-live, payments recorded in the new system must be carried back by hand.
Details and decision points: [cutover.md §5](cutover.md#5-rollback).
