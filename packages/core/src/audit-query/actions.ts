/**
 * What the audit viewer (T-035, FR-024) knows about every audit action the code writes: the kind
 * of thing it is about and the small values its sentence needs ("Ramesh (Staff) changed the phone
 * of customer 1045"). The words live in `packages/i18n/messages/{en,hi}/audit.json` under
 * `sentence.<action>`; `actions.test.ts` scans the source for every action written and fails when
 * one is missing here or has no sentence in either language.
 *
 * An action that is not listed (a newer task's, or one from old data) is still shown, with a
 * safe generic sentence ("Ramesh (Staff) changed a customer") and its change details.
 *
 * Details carry codes, amounts, counts, dates and business names only: never a phone, email,
 * password, token or free-text note (those stay in the redacted change list, see ./present.ts).
 */

/** A value a sentence or a change row shows. The web formats it for the reader's language. */
export type AuditValue =
  /** Plain text (a name, a customer code, a VC or receipt number). */
  | { readonly kind: "text"; readonly value: string }
  /** A code for an ICU `select` (status, method, channel, field); `other` when unknown. */
  | { readonly kind: "code"; readonly value: string }
  /** Money in integer paise (shown as whole rupees with Indian grouping). */
  | { readonly kind: "paise"; readonly value: number }
  /** A count (plural forms). */
  | { readonly kind: "count"; readonly value: number }
  /** An IST business date `YYYY-MM-DD`. */
  | { readonly kind: "date"; readonly value: string }
  /** A billing month `YYYY-MM-01`. */
  | { readonly kind: "period"; readonly value: string }
  /** Changed field names (snake_case), for "changed {fields} of customer 1045". */
  | { readonly kind: "fields"; readonly value: readonly string[] };

/** The `before` / `after` objects of an event (already redacted by the writer). */
export interface AuditDiffInput {
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

export type AuditDetails = Readonly<Record<string, AuditValue>>;

export interface AuditActionSpec {
  /** Extracts the sentence's values from the event's before/after. */
  readonly details?: (diff: AuditDiffInput) => Record<string, AuditValue | undefined>;
}

/** Entity types the viewer can name and filter by (other types still show, as "other"). */
export const AUDIT_ENTITY_TYPES = [
  "customer",
  "vc_assignment",
  "plan",
  "adjustment",
  "payment",
  "receipt",
  "receipt_link",
  "collection_session",
  "billing_run",
  "user",
  "device",
  "area",
  "operator",
  "subscription",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export function isAuditEntityType(value: string): value is AuditEntityType {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------
// Small readers (tolerant: old rows or other writers may lack a key)

function field(obj: Readonly<Record<string, unknown>> | null, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const key of keys) if (key in obj) return obj[key];
  return undefined;
}

function code(value: unknown): AuditValue | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(value)
    ? { kind: "code", value }
    : undefined;
}

function paise(value: unknown): AuditValue | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return { kind: "paise", value };
  if (typeof value === "string" && /^-?\d{1,15}$/.test(value)) {
    return { kind: "paise", value: Number(value) };
  }
  return undefined;
}

function count(value: unknown): AuditValue | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { kind: "count", value }
    : undefined;
}

function date(value: unknown): AuditValue | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { kind: "date", value }
    : undefined;
}

function period(value: unknown): AuditValue | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-01$/.test(value)
    ? { kind: "period", value }
    : undefined;
}

function text(value: unknown): AuditValue | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? { kind: "text", value: value.trim().slice(0, 80) }
    : undefined;
}

/** snake_case of a key (`altPhone` → `alt_phone`). */
export function snakeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** The keys present in before or after, snake_case, in order of first appearance. */
function changedFields({ before, after }: AuditDiffInput): AuditValue | undefined {
  const keys = new Set<string>();
  for (const obj of [after, before])
    for (const key of Object.keys(obj ?? {})) keys.add(snakeKey(key));
  return keys.size > 0 ? { kind: "fields", value: [...keys] } : undefined;
}

const channel = ({ after }: AuditDiffInput) => ({ channel: code(field(after, "channel")) });

const billingRun = ({ after }: AuditDiffInput) => ({ period: period(field(after, "period")) });

const handover = ({ after }: AuditDiffInput) => ({
  amount: paise(field(after, "cash_handed_over_paise")),
  date: date(field(after, "business_date")),
});

// ---------------------------------------------------------------------------------------------
// The registry

/**
 * Every audit action the code writes (and the default action of every audited service), with
 * the values its sentence uses. Keep it sorted by area; add an entry and both sentences
 * (`audit.json` → `sentence.<action>` in en and hi) in the PR that adds the action.
 */
export const AUDIT_ACTIONS = {
  // Sign-in (T-026, T-028)
  "auth.signed_in": { details: channel },
  "auth.sign_in_blocked": { details: channel },
  "auth.signed_out": { details: channel },
  "auth.signed_out_everywhere": {},
  "auth.password_reset_requested": {},
  "auth.password_reset_completed": {},
  "auth.two_factor_enabled": {},
  "mobile_auth.refresh_reuse_detected": {},
  "devices.revoke": {},
  // Business (T-027, T-030)
  "tenant.provisioned": {},
  "operators.update_profile": { details: (diff) => ({ fields: changedFields(diff) }) },
  "areas.create": {},
  "areas.rename": { details: ({ before }) => ({ from: text(field(before, "name")) }) },
  "areas.archive": {},
  "areas.restore": {},
  // Plans (T-031)
  "plans.create": {},
  "plans.update": {
    details: ({ before, after }) => {
      const fields = changedFields({ before, after });
      const shown =
        fields?.kind === "fields" ? fields.value.filter((f) => f !== "connection_count") : [];
      return { fields: shown.length > 0 ? { kind: "fields", value: shown } : undefined };
    },
  },
  "plans.retire": {},
  "plans.restore": {},
  // Team (T-032)
  "team.add_lineman": {},
  "team.add_staff": {},
  "team.reset_password": {},
  "team.deactivate": {},
  "team.reactivate": {},
  // Customers (T-033)
  "customers.create": {},
  "customers.create_with_connections": {},
  // Customer import (T-084): one event per import step, with counts only
  "imports.customers.apply": {
    details: ({ after }) => ({ count: count(field(after, "created")) }),
  },
  "customers.update": {
    details: ({ after }) => ({ fields: changedFields({ before: null, after }) }),
  },
  "customers.set_status": { details: ({ after }) => ({ status: code(field(after, "status")) }) },
  "customers.update_phone": {
    details: ({ after }) => ({
      field: {
        kind: "code",
        value: field(after, "altPhone", "alt_phone") !== undefined ? "alt_phone" : "phone",
      },
    }),
  },
  // Connections (T-034)
  "connections.add": {},
  "connections.suspend": {
    details: ({ after }) => ({ date: date(field(after, "effectiveDate")) }),
  },
  "connections.reactivate": {
    details: ({ after }) => ({ date: date(field(after, "effectiveDate")) }),
  },
  "connections.disconnect": {
    details: ({ after }) => ({ date: date(field(after, "effectiveDate")) }),
  },
  "connections.change_plan": {
    details: ({ before, after }) => ({
      from: paise(field(before, "rentalPaise", "rental_paise")),
      to: paise(field(after, "rentalPaise", "rental_paise")),
    }),
  },
  // Bill changes (T-045)
  "adjustments.create": {
    details: ({ after }) => ({
      direction: code(field(after, "direction")),
      amount: paise(field(after, "amountPaise", "amount_paise")),
    }),
  },
  "adjustments.back_dated_change": {
    details: ({ after }) => ({
      kind: code(field(after, "kind")),
      date: date(field(after, "effectiveDate", "effective_date")),
    }),
  },
  // Payments and receipts (T-046, T-048, T-050)
  "payments.post": {
    details: ({ after }) => ({
      amount: paise(field(after, "amount_paise")),
      method: code(field(after, "method")),
    }),
  },
  "payments.reverse": { details: ({ after }) => ({ amount: paise(field(after, "amount_paise")) }) },
  "payments.resolve_review": {},
  "receipts.create_link": {},
  "receipts.revoke_links": {
    details: ({ after }) => {
      const ids = field(after, "revoked_link_ids");
      return { count: count(Array.isArray(ids) ? ids.length : undefined) };
    },
  },
  "receipt_links.purged": { details: ({ after }) => ({ count: count(field(after, "count")) }) },
  // Cash handover (T-062)
  "handover.submit": { details: handover },
  "handover.accept": { details: handover },
  "handover.return": { details: handover },
  // App subscription (T-085)
  "subscriptions.checkout_started": {},
  "subscription.state_changed": {
    details: ({ after }) => ({ status: code(field(after, "status")) }),
  },
  "subscription.notice_sent": {
    details: ({ after }) => ({ count: count(field(after, "recipients")) }),
  },
  // Bills (T-043, T-044)
  "billing.run_scheduled": { details: billingRun },
  "billing.run_skipped": { details: billingRun },
  "billing.run_requeued": { details: billingRun },
  "billing.run_started": { details: billingRun },
  "billing.run_retry_started": { details: billingRun },
  "billing.run_completed": {
    details: ({ after }) => ({
      period: period(field(after, "period")),
      status: code(field(after, "status")),
      count: count(field(after, "created_count")),
    }),
  },
  "billing.start_run": { details: billingRun },
  "billing.retry_failed": { details: billingRun },
  // Platform admin console (T-086). `support.*` and `subscription.offline_payment_recorded` are
  // written to the tenant's own log (the Owner reads them here); `admin.*` are platform events
  // (operator_id NULL), never in a tenant's log, listed so every written action has words.
  // How long the grant runs (15–120 minutes, written by `admin.support_access_grant`). Never the
  // reason: it is free text.
  "support.access_granted": {
    details: ({ after }) => ({ count: count(field(after, "minutes")) }),
  },
  "support.data_viewed": {},
  "support.access_ended": {},
  "subscription.offline_payment_recorded": {
    details: ({ after }) => ({
      amount: paise(field(after, "amount_paise")),
      count: count(field(after, "months")),
    }),
  },
  "admin.tenants_listed": {},
  "admin.tenant_viewed": {},
  "admin.tenant_created": {},
  "admin.subscription_extended": {},
  "admin.offline_payment_recorded": {},
  "admin.support_access_granted": {},
  "admin.support_access_ended": {},
  "admin.support_data_viewed": {},
  "admin.jobs_viewed": {},
  "admin.job_retried": {},
  "admin.billing_runs_viewed": {},
  "admin.razorpay_events_viewed": {},
  "admin.audit_viewed": {},
  "admin.metrics_viewed": {},
} as const satisfies Record<string, AuditActionSpec>;

export type KnownAuditAction = keyof typeof AUDIT_ACTIONS;

export const KNOWN_AUDIT_ACTIONS = Object.keys(AUDIT_ACTIONS).sort() as KnownAuditAction[];

export function isKnownAuditAction(action: string): action is KnownAuditAction {
  return Object.hasOwn(AUDIT_ACTIONS, action);
}

/** The sentence values of a known action (unknown actions have none). */
export function auditDetails(action: string, diff: AuditDiffInput): AuditDetails {
  if (!isKnownAuditAction(action)) return {};
  const spec: AuditActionSpec = AUDIT_ACTIONS[action];
  const out: Record<string, AuditValue> = {};
  for (const [key, value] of Object.entries(spec.details?.(diff) ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
