# Runbook: the books check failed (invariant breach)

Alert: `invariant-breach` (`job.failed`, `job_type=invariants.check`), plus the T-043 email to the
platform admins (`last_error = permanent: invariant_breach` or `permanent: invariant_check_incomplete`).
Background: T-052, PLAN §8.4 and §14.

Every night at 02:30 IST the `invariants.check` job checks each tenant's books in one read-only
statement: Σ ledger = balances, allocations never exceed their payment or credit, reversed payments
are fully unallocated, credit = unallocated remainders, no overlapping VC assignments, one regular
invoice per customer and month. It **never changes anything**. The result per tenant is a row in
`invariant_checks` (`ok` or `breach`, counts per code, up to 20 sample ids per code).

A breach is **P1**: it means a bug, a bypassed constraint, or someone writing to the database by hand.
Bills for affected customers are also refused by the bill run (`balance_mismatch` / `credit_mismatch`
items), so it does not spread into new invoices.

## What to do

1. **Find the tenants and codes** (read-only SQL, owner URL):
   ```sql
   SELECT operator_id, run_id, checked_at, violation_count, counts
   FROM invariant_checks WHERE status = 'breach'
   ORDER BY checked_at DESC LIMIT 20;
   -- The sample rows (ids and paise amounts only) for one tenant and run:
   SELECT jsonb_pretty(samples) FROM invariant_checks WHERE operator_id = '<id>' AND run_id = '<run id>';
   ```
   `invariant_check_incomplete` instead: a tenant's check itself errored (statement timeout 60 s, a
   connection drop). Look for `invariants.tenant_check_failed` in the logs (error type and SQLSTATE).
   Re-run the check (step 5); if it times out again, the tenant has grown and the check needs work.
2. **Was it new?** Compare with the previous nights (`checked_at`). A breach that appeared right after
   a deploy points at that deploy (Vercel → Deployments, the commits between them).
3. **Understand one sample per code** (codes in `packages/core/src/invariants/codes.ts`):

   | Code | Usually means |
   |---|---|
   | `BALANCE_MISMATCH` | `customer_balances` (read model) drifted from Σ `ledger_entries` |
   | `CREDIT_MISMATCH` | stored credit ≠ unallocated payment remainders + credit adjustments |
   | `LEDGER_MISMATCH` | a ledger entry with no matching document, or a document without its entry |
   | `ALLOCATIONS_EXCEED_PAYMENT` / `…_CREDIT_ADJUSTMENT` | more was allocated than the source had |
   | `NEGATIVE_OUTSTANDING`, `OUTSTANDING_EXCEEDS_CHARGES` | an invoice paid more than its charges, or negative |
   | `REVERSED_PAYMENT_STILL_ALLOCATED`, `NEGATIVE_ALLOCATION_WITHOUT_REVERSAL` | a reversal left allocations behind, or a negative row no reversal explains |
   | `OVERLAPPING_ASSIGNMENTS` | one VC on two customers at once (the EXCLUDE constraint was dropped or bypassed) |
   | `DUPLICATE_REGULAR_INVOICE` | two regular bills for one customer and month (the unique index was dropped or bypassed) |

   Read the customer's history in the app (Customers → the customer → statement) and the audit log
   (`audit_events` for that entity id). Check that the constraints still exist:
   `\d+ vc_assignments`, `\d+ invoices` in psql.
4. **Correct it the append-only way**, never with `UPDATE`/`DELETE` on financial tables (CLAUDE.md;
   the triggers refuse it anyway, and switching triggers off is forbidden):
   - money wrong for a customer → the Owner (or support with the Owner, support-access.md) posts a
     **reversal** of the wrong payment and/or a **credit or debit adjustment**, with a note naming the
     incident;
   - a duplicate bill → reverse the effect with a credit adjustment for that month and note it;
   - only the **read model** `customer_balances` drifted while the ledger is right → this is a code bug:
     fix the code that writes it (it must be recomputed by a reviewed migration or service, in a PR,
     never by a hand-written `UPDATE` in production);
   - a dropped constraint → restore it with a reviewed migration.
   If you can't tell what the right numbers are, stop and ask the product owner; don't guess.
5. **Re-run the check** after the fix (it is safe at any time):
   ```bash
   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<production host>/api/cron/invariants
   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<production host>/api/cron/job-worker
   ```
   A new `ok` row per tenant (and no new alert) closes it. Customers whose bill was refused get billed
   by the Owner's **Try problems again** (billing-run-failure.md §1.1).
6. Write the incident note (README.md §2): which tenants, codes, cause, corrections (their ids), and
   whether the Owner was told. If the cause was a hand-written query in production, say so plainly.
