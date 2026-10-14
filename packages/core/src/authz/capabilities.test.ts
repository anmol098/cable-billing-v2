/**
 * The role matrix, cell by cell. EXPECTED is written out by hand from PLAN §9.3 (D-16) and is
 * never derived from CAPABILITIES: if someone edits the table in capabilities.ts, a cell here
 * fails until a reviewer-visible edit is made here too.
 *
 *   PLAN §9.3 row                                      Owner Staff Lineman
 *   Web dashboard                                        ✅    ✅    ❌ (Android only)
 *   Customers, connections, contact edits                ✅    ✅    view only (Android)
 *   Change VC status (suspend, disconnect, reactivate)   ✅    ✅    ❌
 *   Plans: create, edit, retire                          ✅    ❌    ❌
 *   Record payment (counter / field)                     ✅    ✅    ✅
 *   Reverse a payment                                    ✅    ❌    ❌
 *   Manual adjustment / back-dated change                ✅    ❌    ❌
 *   Billing preview                                      ✅    ✅    ❌
 *   Run / retry billing                                  ✅    ❌    ❌
 *   Accept / return cash handover                        ✅    ✅    ❌
 *   Reports (view)                                       ✅    ✅    own day only
 *   Exports (CSV)                                        ✅    ❌    ❌
 *   Team management, reset lineman password, sign out   ✅    ❌    ❌
 *   Subscription and business profile                    ✅    ❌    ❌
 *   Audit log                                            ✅    ❌    ❌
 *
 * Two capabilities are not a §9.3 cell as such and are flagged in the T-025 completion notes:
 * `customers.phone.update` (lineman ✅: FR-004 / PLAN §10.2 phone correction in the receipt flow)
 * and `handover.submit` (lineman only: PLAN §8.7, the other side of "Accept / return").
 */
import { USER_ROLES } from "@cb/db";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_NAMES, type Capability, can, isTenantRole } from "./capabilities";

const Y = true;
const N = false;

/** [capability, owner, staff, lineman, kind, audited] */
const EXPECTED: ReadonlyArray<
  readonly [Capability, boolean, boolean, boolean, "read" | "write", boolean]
> = [
  ["dashboard.view", Y, Y, N, "read", N],
  ["customers.view", Y, Y, Y, "read", N],
  ["customers.manage", Y, Y, N, "write", Y],
  ["customers.phone.update", Y, Y, Y, "write", Y],
  ["connections.status.change", Y, Y, N, "write", Y],
  ["plans.manage", Y, N, N, "write", Y],
  ["payments.record", Y, Y, Y, "write", Y],
  ["receipts.share", Y, Y, Y, "write", N],
  ["payments.reverse", Y, N, N, "write", Y],
  ["adjustments.manage", Y, N, N, "write", Y],
  ["billing.preview", Y, Y, N, "read", N],
  ["billing.run", Y, N, N, "write", Y],
  ["handover.submit", N, N, Y, "write", Y],
  ["handover.review", Y, Y, N, "write", Y],
  ["reports.view", Y, Y, N, "read", N],
  ["reports.own_day.view", Y, Y, Y, "read", N],
  ["exports.csv", Y, N, N, "read", Y],
  ["team.view", Y, N, N, "read", N], // T-032: the Team page list, viewable in read-only mode
  ["team.manage", Y, N, N, "write", Y],
  ["subscription.manage", Y, N, N, "write", Y],
  ["business_profile.manage", Y, N, N, "write", Y],
  ["audit.view", Y, N, N, "read", N],
];

const ROLES = ["owner", "staff", "lineman"] as const;

const cells = EXPECTED.flatMap(([capability, owner, staff, lineman]) =>
  ROLES.map((role, i) => [capability, role, [owner, staff, lineman][i] as boolean] as const),
);

describe("can(role, capability): PLAN §9.3 matrix", () => {
  it.each(cells)("%s × %s → %s", (capability, role, allowed) => {
    expect(can(role, capability)).toBe(allowed);
  });

  it.each(CAPABILITY_NAMES)("platform_admin has no tenant capability: %s", (capability) => {
    expect(can("platform_admin", capability)).toBe(false);
  });

  it("every capability in the code has an expected row, and no row is missing from the code", () => {
    expect(EXPECTED.map(([c]) => c).sort()).toEqual([...CAPABILITY_NAMES].sort());
  });

  it.each(EXPECTED)("%s: kind and audit flag", (capability, _o, _s, _l, kind, audited) => {
    expect(CAPABILITIES[capability].kind).toBe(kind);
    expect(CAPABILITIES[capability].audited).toBe(audited);
  });

  it("unknown roles and capabilities are denied", () => {
    expect(can("root" as never, "dashboard.view")).toBe(false);
    expect(can("owner", "everything" as never)).toBe(false);
    expect(can("owner", "toString" as never)).toBe(false);
  });

  it("tenant roles are the user roles minus platform_admin", () => {
    expect(USER_ROLES.filter(isTenantRole)).toEqual(["owner", "staff", "lineman"]);
  });
});
