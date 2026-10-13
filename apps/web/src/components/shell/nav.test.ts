import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { isCapability, type TenantRole } from "@cb/core";
import { describe, expect, it } from "vitest";
import { isProtectedPath, PROTECTED_PREFIXES } from "@/lib/auth/paths";
import {
  allRoutes,
  canSeeRoute,
  isActivePath,
  NAV,
  NAV_SECTION_IDS,
  splitForBottomBar,
  visibleChildren,
  visibleSections,
} from "@/lib/nav";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";
import { roleCan } from "./access";
import { setupStepsFor } from "./setup-checklist";
import { bannerFor } from "./subscription-banner";

const OPERATOR_APP = join(process.cwd(), "src", "app", "(operator)");

/** URL paths of every `page.tsx` under the (operator) route group. */
function pagePaths(): string[] {
  return readdirSync(OPERATOR_APP, { recursive: true, encoding: "utf8" })
    .filter((file) => file === "page.tsx" || file.endsWith(`${sep}page.tsx`))
    .map((file) => `/${file.split(sep).slice(0, -1).join("/")}`)
    .sort();
}

/** Static sub-route ids per section a role sees (hand-written from PLAN §9.3 / §12.1). */
const EXPECTED_CHILDREN: Record<"owner" | "staff", Record<string, string[]>> = {
  owner: {
    home: [],
    customers: ["customers_new", "customers_import"],
    payments: ["payments_new", "payments_check", "payments_reversals"],
    linemen: [],
    bills: ["bills_runs", "bills_register", "bills_adjustments"],
    reports: [
      "reports_dues",
      "reports_bills",
      "reports_payments",
      "reports_collections",
      "reports_handover",
      "reports_connections",
      "reports_billing_runs",
      "reports_export",
    ],
    settings: [
      "settings_profile",
      "settings_areas",
      "settings_plans",
      "settings_team",
      "settings_subscription",
      "settings_audit",
    ],
  },
  staff: {
    home: [],
    customers: ["customers_new", "customers_import"],
    // No "Undo payment" (payments.reverse), "Bill changes" (adjustments.manage), "Download data"
    // (exports.csv), Team, Subscription or Audit: Owner only (PLAN §9.3).
    payments: ["payments_new", "payments_check"],
    linemen: [],
    bills: ["bills_runs", "bills_register"],
    reports: [
      "reports_dues",
      "reports_bills",
      "reports_payments",
      "reports_collections",
      "reports_handover",
      "reports_connections",
      "reports_billing_runs",
    ],
    settings: ["settings_profile", "settings_areas", "settings_plans"],
  },
};

const OWNER_ONLY = [
  "payments_reversals",
  "bills_adjustments",
  "reports_export",
  "settings_team",
  "settings_subscription",
  "settings_audit",
];

describe("navigation config (PLAN §12.1)", () => {
  it("has the 7 sections in order, each with a unique id and path", () => {
    expect(NAV.map((section) => section.id)).toEqual([...NAV_SECTION_IDS]);
    expect(NAV).toHaveLength(7);
    const routes = allRoutes();
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
    expect(new Set(routes.map((r) => r.path)).size).toBe(routes.length);
    for (const section of NAV) {
      for (const child of section.children)
        expect(child.path.startsWith(`${section.path}/`)).toBe(true);
    }
  });

  it("uses only real capabilities from @cb/core", () => {
    for (const route of allRoutes()) expect(isCapability(route.capability), route.id).toBe(true);
  });

  it("has an English and a Hindi word for every route", () => {
    for (const route of allRoutes()) {
      expect(en.shell.routes[route.id], route.id).toBeTruthy();
      expect(hi.shell.routes[route.id], route.id).toBeTruthy();
    }
  });

  it("has exactly one page.tsx per route (placeholders until feature tasks replace them)", () => {
    expect(pagePaths()).toEqual(
      allRoutes()
        .map((route) => route.path)
        .sort(),
    );
  });

  it("is protected by the proxy: every section is in PROTECTED_PREFIXES (T-026)", () => {
    for (const section of NAV) expect(PROTECTED_PREFIXES).toContain(section.path);
    for (const route of allRoutes()) expect(isProtectedPath(route.path), route.path).toBe(true);
  });
});

describe("who sees what (capabilities, PLAN §9.3)", () => {
  it.each(["owner", "staff"] as const)("%s sees all 7 sections and the right pages", (role) => {
    const can = roleCan(role);
    expect(visibleSections(can).map((s) => s.id)).toEqual([...NAV_SECTION_IDS]);
    for (const section of NAV_SECTION_IDS) {
      expect(
        visibleChildren(section, can).map((c) => c.id),
        `${role} ${section}`,
      ).toEqual(EXPECTED_CHILDREN[role][section]);
    }
  });

  it("Staff can't open Owner-only pages (the placeholder answers 404)", () => {
    const owner = roleCan("owner");
    const staff = roleCan("staff");
    for (const id of OWNER_ONLY) {
      expect(canSeeRoute(id, owner), id).toBe(true);
      expect(canSeeRoute(id, staff), id).toBe(false);
    }
    // Everything else, including the dynamic detail pages, is open to Staff.
    for (const route of allRoutes().filter((r) => !OWNER_ONLY.includes(r.id))) {
      expect(canSeeRoute(route.id, staff), route.id).toBe(true);
    }
  });

  it("linemen see nothing on the web (Android only, D-16)", () => {
    const lineman = roleCan("lineman" satisfies TenantRole);
    expect(visibleSections(lineman)).toEqual([]);
    expect(allRoutes().some((route) => canSeeRoute(route.id, lineman))).toBe(false);
  });

  it("unknown routes are never visible", () => {
    expect(canSeeRoute("nope", roleCan("owner"))).toBe(false);
  });
});

describe("helpers", () => {
  it("splits 7 sections into 3 + More on phones, and keeps 4 or fewer in the bar", () => {
    const seven = [1, 2, 3, 4, 5, 6, 7];
    expect(splitForBottomBar(seven)).toEqual({ bar: [1, 2, 3], more: [4, 5, 6, 7] });
    expect(splitForBottomBar([1, 2, 3, 4])).toEqual({ bar: [1, 2, 3, 4], more: [] });
  });

  it("marks a section active on its own page and every page under it", () => {
    expect(isActivePath("/customers", "/customers")).toBe(true);
    expect(isActivePath("/customers/123/bills", "/customers")).toBe(true);
    expect(isActivePath("/customersx", "/customers")).toBe(false);
    expect(isActivePath("/home", "/customers")).toBe(false);
  });

  it("setup checklist: the Owner gets all 4 steps, Staff only 'Add customers'", () => {
    expect(setupStepsFor(roleCan("owner")).map((s) => [s.id, s.href, s.done])).toEqual([
      ["plans", "/settings/plans", false],
      ["customers", "/customers/new", false],
      ["linemen", "/settings/team", false],
      ["app", undefined, false],
    ]);
    expect(setupStepsFor(roleCan("staff"), { customers: true })).toEqual([
      { id: "customers", done: true, href: "/customers/new" },
    ]);
  });

  it("subscription banner: grace for the Owner only, read-only for everyone (fail closed)", () => {
    const graceEndsAt = new Date("2026-10-20T10:00:00Z");
    expect(bannerFor({ status: "trialing", graceEndsAt: null }, true)).toBeNull();
    expect(bannerFor({ status: "active", graceEndsAt: null }, true)).toBeNull();
    expect(bannerFor({ status: "grace", graceEndsAt }, true)).toEqual({
      kind: "grace",
      graceEndsAt,
      canPay: true,
    });
    expect(bannerFor({ status: "grace", graceEndsAt }, false)).toBeNull();
    for (const status of ["read_only", "cancelled", null] as const) {
      expect(bannerFor({ status, graceEndsAt: null }, true)).toEqual({
        kind: "read_only",
        canPay: true,
      });
      expect(bannerFor({ status, graceEndsAt: null }, false)).toEqual({
        kind: "read_only",
        canPay: false,
      });
    }
  });
});
