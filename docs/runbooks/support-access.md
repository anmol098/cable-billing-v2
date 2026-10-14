# Runbook: tenant support access

Who this is for: platform admins and anyone answering operators' support calls. Policy from PLAN §9.4
and §12.4, PRD §3, BRD §15 ("Tenant security: cross-tenant access tests and support-access policy
review"). The admin console screens are T-086's.

## The policy

- **No routine access to an operator's data.** Their customers, bills and payments belong to them.
  We look only when the Owner asks for help with a specific problem, or during an incident.
- Access is **time-boxed** (at most **2 hours**), needs a **written reason**, and is **visible to the
  operator** in their own audit log (Settings → Audit, `/settings/audit`, Owner). Platform admins sign in with 2FA.
- **We never change financial records for an operator.** Payments, bills, reversals and adjustments are
  made by the Owner in their app (or by us only with the Owner's explicit request in writing, through
  the same audited app screens, never SQL). Corrections are reversals or adjustments, never edits.
- We never export or copy an operator's data out of the app, and never paste customer names, phone
  numbers or amounts into tickets, chats or Sentry. Use ids (customer code, receipt number).

## 1. A support request comes in

1. **Who is asking?** Only the business's **Owner** can ask for support access. Verify by calling back
   the Owner's mobile number stored for that business (admin console → the tenant), not the number
   that called you. Staff and linemen are helped without data access, or the Owner is asked.
2. **Try without access first.** Most questions are answered by guiding the Owner on the phone:
   where a screen is, what a word means, why a bill is what it is (their statement shows it).
3. Open a support ticket with: business name, the Owner's request in their words, and your reason for
   needing access (one sentence, no customer data).

## 2. Granting access (admin console, T-086)

> T-086 (platform admin console) is in review while this is written. When it merges, replace this
> box with the exact clicks. The rules below don't change.

1. Admin → Tenants → the business → **Support access** → reason (paste the ticket's one sentence) →
   duration (default and maximum **2 hours**) → start.
2. The grant is written to the platform audit log **and** the tenant's audit log; the Owner can see
   it. Tell the Owner: "I can look at your account for the next 2 hours. You will see it in your audit
   list."
3. Do the work. Read only what the problem needs.
4. End the access as soon as you are done (or let it expire). Note on the ticket what you looked at
   and what was changed by whom.

## 3. Database access by engineers (break-glass, not support)

The production owner URL (password manager) is for **incidents** only: migrations through the
gated workflow, restores (backup-and-restore.md), and read-only diagnosis in the runbooks.

- Use it only for an open incident (README.md §2), with a named engineer, from your own machine.
- Read-only queries (`BEGIN READ ONLY;` first). Ids and counts in your notes, never names or phones.
- No `UPDATE`/`DELETE`/`INSERT` on any tenant table. A data fix ships as a reviewed migration or service
  change, or is made by the Owner in the app.
- Write in the incident note what you queried and why. If you saw an operator's customer data, say so
  in the note (the Owner may need to be told, depending on what happened).

## 4. Requests about data (privacy)

- **"Give me all my data"**: the Owner downloads it themselves (Reports → Download data, `/reports/export`, Owner only).
- **"Delete my business / a customer"**: not supported yet; retention and deletion policy is open
  question Q-06 (legal review). Record the request and tell the Owner when they will hear back.
- A request from a cable **customer** (not an operator) goes to that operator: we process their data
  on the operator's behalf.
