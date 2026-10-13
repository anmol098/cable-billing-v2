/**
 * Capabilities and the fixed role matrix (PLAN §9.3, D-16). There are no permission toggles: this
 * table *is* the authorization model. Every service declares exactly one capability.
 *
 * Each capability says
 * - `roles`: who may use it (owner / staff / lineman; the platform admin has no tenant capability:
 *   "no routine access to tenant financial data", PRD §3);
 * - `kind`: `read` capabilities run in a READ ONLY transaction and are always allowed in read-only
 *   mode; `write` capabilities are checked against the read-only allowlist (./writable.ts);
 * - `audited`: the service must write an audit event (FR-024) in the same transaction, or
 *   explicitly skip it for a no-op (see `AuditRecorder.skip`);
 * - `row`: the §9.3 row it comes from (for reviewers and the matrix test).
 *
 * Adding a capability is a security change: add the row here, the expected cells in
 * `capabilities.test.ts` (written out by hand from PLAN §9.3, never derived from this table), and
 * say in the PR why.
 */
import type { UserRole } from "@cb/db";

/** The roles inside a tenant (D-16). The platform admin is not one of them. */
export const TENANT_ROLES = ["owner", "staff", "lineman"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export function isTenantRole(role: string): role is TenantRole {
  return (TENANT_ROLES as readonly string[]).includes(role);
}

export type CapabilityKind = "read" | "write";

export interface CapabilitySpec {
  readonly roles: readonly TenantRole[];
  readonly kind: CapabilityKind;
  readonly audited: boolean;
  /** The PLAN §9.3 row (or the PLAN/PRD section) this capability implements. */
  readonly row: string;
}

const O = "owner";
const S = "staff";
const L = "lineman";

export const CAPABILITIES = {
  // §9.3 "Web dashboard": every web screen's reads (settings, plans, areas, lists).
  "dashboard.view": { roles: [O, S], kind: "read", audited: false, row: "Web dashboard" },
  // §9.3 "Customers, connections, contact edits": lineman = view only (Android).
  "customers.view": {
    roles: [O, S, L],
    kind: "read",
    audited: false,
    row: "Customers, connections, contact edits",
  },
  "customers.manage": {
    roles: [O, S],
    kind: "write",
    audited: true,
    row: "Customers, connections, contact edits",
  },
  // FR-004 / PLAN §10.2 `PATCH /customers/{id}/phone` / §11.7: the lineman confirms or corrects the
  // customer's phone in the receipt flow. Narrower than "contact edits"; see the completion notes.
  "customers.phone.update": {
    roles: [O, S, L],
    kind: "write",
    audited: true,
    row: "Customers, connections, contact edits (+ FR-004 receipt-flow phone correction)",
  },
  "connections.status.change": {
    roles: [O, S],
    kind: "write",
    audited: true,
    row: "Change VC status (suspend, disconnect, reactivate)",
  },
  "plans.manage": { roles: [O], kind: "write", audited: true, row: "Plans: create, edit, retire" },
  // PLAN §8.4 post_payment ends with "audit".
  "payments.record": {
    roles: [O, S, L],
    kind: "write",
    audited: true,
    row: "Record payment (counter / field)",
  },
  // Receipt preview links and printed/opened actions (part of recording a payment; T-050, T-061).
  "receipts.share": {
    roles: [O, S, L],
    kind: "write",
    audited: false,
    row: "Record payment (counter / field)",
  },
  "payments.reverse": { roles: [O], kind: "write", audited: true, row: "Reverse a payment" },
  "adjustments.manage": {
    roles: [O],
    kind: "write",
    audited: true,
    row: "Manual adjustment / back-dated change",
  },
  "billing.preview": { roles: [O, S], kind: "read", audited: false, row: "Billing preview" },
  "billing.run": { roles: [O], kind: "write", audited: true, row: "Run / retry billing" },
  // PLAN §8.7 / J-05: the lineman submits the day's cash handover (on Android).
  "handover.submit": {
    roles: [L],
    kind: "write",
    audited: true,
    row: "Accept / return cash handover (the lineman's side, PLAN §8.7)",
  },
  "handover.review": {
    roles: [O, S],
    kind: "write",
    audited: true,
    row: "Accept / return cash handover",
  },
  "reports.view": { roles: [O, S], kind: "read", audited: false, row: "Reports (view)" },
  "reports.own_day.view": {
    roles: [O, S, L],
    kind: "read",
    audited: false,
    row: "Reports (view): lineman own day only",
  },
  // T-082: exports are reads, but every export is audited.
  "exports.csv": { roles: [O], kind: "read", audited: true, row: "Exports (CSV)" },
  "team.manage": {
    roles: [O],
    kind: "write",
    audited: true,
    row: "Team management, reset lineman password, sign out a phone",
  },
  "subscription.manage": {
    roles: [O],
    kind: "write",
    audited: true,
    row: "Subscription and business profile",
  },
  // Business profile, receipt footer, invoice prefix, mid-month policy and areas (T-030).
  "business_profile.manage": {
    roles: [O],
    kind: "write",
    audited: true,
    row: "Subscription and business profile",
  },
  "audit.view": { roles: [O], kind: "read", audited: false, row: "Audit log" },
} as const satisfies Record<string, CapabilitySpec>;

export type Capability = keyof typeof CAPABILITIES;

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(name: string): name is Capability {
  return Object.hasOwn(CAPABILITIES, name);
}

export function capabilitySpec(capability: Capability): CapabilitySpec {
  return CAPABILITIES[capability];
}

/**
 * May `role` use `capability`? Data-driven from {@link CAPABILITIES}. `platform_admin` (and any
 * unknown role or capability) gets `false`.
 */
export function can(role: UserRole, capability: Capability): boolean {
  // Runtime guards too: role and capability may come from untyped data (a DB row, a test table).
  if (!isTenantRole(role) || !isCapability(capability)) return false;
  return (CAPABILITIES[capability].roles as readonly string[]).includes(role);
}

/** The roles allowed a capability, in matrix order. */
export function rolesFor(capability: Capability): readonly TenantRole[] {
  return CAPABILITIES[capability].roles;
}
