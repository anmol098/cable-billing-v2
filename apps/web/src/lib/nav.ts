/**
 * The operator app's navigation (PLAN §12.1): the 7 sections, every sub-route, and who may see
 * each one. Single source for the sidebar, the phone bottom bar + "More", the section menus and
 * the placeholder pages (T-029). Feature tasks replace a route's placeholder `page.tsx`; they don't
 * edit this file unless a route is added or removed (a test checks every route has a page and
 * every page has a route).
 *
 * Visibility comes from the T-025 capability matrix (`can(role, capability)`), never from role
 * names: a section is shown when the role has the section's capability, and a sub-route when the
 * role has both the section's and the route's capability. Hiding is not the security boundary:
 * pages call `getTenantContext()` (placeholders also 404 a route the role can't see) and services
 * check the capability again.
 *
 * Pure data + pure functions (no server imports) so client components and tests can use it.
 * Labels live in `packages/i18n/messages/{en,hi}/shell.json` under `routes.<id>`.
 */
import type { IconName } from "@cb/ui";

/**
 * A capability name from `@cb/core` `CAPABILITIES` (repeated as a type here so this file stays
 * free of server code; `nav.test.ts` checks each one is a real capability).
 */
export type NavCapability =
  | "dashboard.view"
  | "customers.view"
  | "customers.manage"
  | "payments.record"
  | "payments.reverse"
  | "adjustments.manage"
  | "billing.preview"
  | "handover.review"
  | "reports.view"
  | "exports.csv"
  | "team.manage"
  | "subscription.manage"
  | "business_profile.manage"
  | "plans.manage"
  | "audit.view";

/** The 7 top-level sections, in menu order. */
export const NAV_SECTION_IDS = [
  "home",
  "customers",
  "payments",
  "linemen",
  "bills",
  "reports",
  "settings",
] as const;
export type NavSectionId = (typeof NAV_SECTION_IDS)[number];

type RouteSpec = {
  /** Message key under `shell.routes` (title) and the placeholder's id. */
  id: string;
  /** URL path. Dynamic segments use Next's folder syntax (`/customers/[id]`). */
  path: string;
  icon: IconName;
  capability: NavCapability;
};

type SectionSpec = RouteSpec & {
  id: NavSectionId;
  /** Sub-routes listed on the section's page (static ones) and given placeholders (all). */
  children: readonly RouteSpec[];
};

/**
 * Seeing the business profile, areas and plans needs no more than the dashboard: T-030 makes
 * them read-only for Staff (only the Owner may change them; the services check `*.manage`).
 */
const ANY_WEB_USER: NavCapability = "dashboard.view";

export const NAV = [
  {
    id: "home",
    path: "/home",
    icon: "home",
    capability: "dashboard.view",
    children: [],
  },
  {
    id: "customers",
    path: "/customers",
    icon: "customer",
    capability: "customers.view",
    children: [
      { id: "customers_new", path: "/customers/new", icon: "add", capability: "customers.manage" },
      {
        id: "customers_import",
        path: "/customers/import",
        icon: "import",
        capability: "customers.manage",
      },
      {
        id: "customer_summary",
        path: "/customers/[id]",
        icon: "customer",
        capability: "customers.view",
      },
      {
        id: "customer_connections",
        path: "/customers/[id]/connections",
        icon: "plan",
        capability: "customers.view",
      },
      {
        id: "customer_bills",
        path: "/customers/[id]/bills",
        icon: "bill",
        capability: "customers.view",
      },
      {
        id: "customer_payments",
        path: "/customers/[id]/payments",
        icon: "collect",
        capability: "customers.view",
      },
      {
        id: "customer_history",
        path: "/customers/[id]/history",
        icon: "audit",
        capability: "customers.view",
      },
    ],
  },
  {
    id: "payments",
    path: "/payments",
    icon: "collect",
    capability: "payments.record",
    children: [
      { id: "payments_new", path: "/payments/new", icon: "add", capability: "payments.record" },
      {
        id: "payments_check",
        path: "/payments/review",
        icon: "danger",
        capability: "payments.record",
      },
      {
        id: "payments_reversals",
        path: "/payments/reversals",
        icon: "undo",
        capability: "payments.reverse",
      },
    ],
  },
  {
    id: "linemen",
    path: "/linemen",
    icon: "lineman",
    capability: "handover.review",
    children: [
      { id: "lineman_day", path: "/linemen/[id]", icon: "handover", capability: "handover.review" },
    ],
  },
  {
    id: "bills",
    path: "/bills",
    icon: "bill",
    capability: "billing.preview",
    children: [
      { id: "bills_runs", path: "/bills/runs", icon: "today", capability: "billing.preview" },
      {
        id: "bills_register",
        path: "/bills/register",
        icon: "bill",
        capability: "billing.preview",
      },
      {
        id: "bills_adjustments",
        path: "/bills/adjustments",
        icon: "edit",
        capability: "adjustments.manage",
      },
      { id: "bill_detail", path: "/bills/[id]", icon: "bill", capability: "billing.preview" },
    ],
  },
  {
    id: "reports",
    path: "/reports",
    icon: "report",
    capability: "reports.view",
    children: [
      { id: "reports_dues", path: "/reports/dues", icon: "report", capability: "reports.view" },
      { id: "reports_bills", path: "/reports/bills", icon: "bill", capability: "reports.view" },
      {
        id: "reports_payments",
        path: "/reports/payments",
        icon: "collect",
        capability: "reports.view",
      },
      {
        id: "reports_collections",
        path: "/reports/collections",
        icon: "today",
        capability: "reports.view",
      },
      {
        id: "reports_handover",
        path: "/reports/handover",
        icon: "handover",
        capability: "reports.view",
      },
      {
        id: "reports_connections",
        path: "/reports/connections",
        icon: "plan",
        capability: "reports.view",
      },
      {
        id: "reports_billing_runs",
        path: "/reports/billing-runs",
        icon: "bill",
        capability: "reports.view",
      },
      { id: "reports_export", path: "/reports/export", icon: "export", capability: "exports.csv" },
    ],
  },
  {
    id: "settings",
    path: "/settings",
    icon: "settings",
    capability: ANY_WEB_USER,
    children: [
      {
        id: "settings_profile",
        path: "/settings/profile",
        icon: "business",
        capability: ANY_WEB_USER,
      },
      { id: "settings_areas", path: "/settings/areas", icon: "area", capability: ANY_WEB_USER },
      { id: "settings_plans", path: "/settings/plans", icon: "plan", capability: ANY_WEB_USER },
      { id: "settings_team", path: "/settings/team", icon: "team", capability: "team.manage" },
      {
        id: "settings_subscription",
        path: "/settings/subscription",
        icon: "subscription",
        capability: "subscription.manage",
      },
      { id: "settings_audit", path: "/settings/audit", icon: "audit", capability: "audit.view" },
    ],
  },
] as const satisfies readonly SectionSpec[];

/** Every route id (sections and sub-routes): the `shell.routes.<id>` message keys. */
export type NavRouteId = NavSectionId | (typeof NAV)[number]["children"][number]["id"];

/** A route (section or sub-route). */
export type NavRoute = Omit<RouteSpec, "id"> & { id: NavRouteId };

/** A top-level section with its sub-routes. */
export type NavSection = Omit<SectionSpec, "children"> & { children: readonly NavRoute[] };

/** `can(role, capability)` from `@cb/core`, passed in so this module stays client-safe. */
export type CanFn = (capability: NavCapability) => boolean;

// The literal NAV, widened once (its ids are exactly NavRouteId by construction).
const SECTIONS = NAV as readonly NavSection[];

/** True when the path has a dynamic segment (`[id]`): not linked from menus. */
export function isDynamicPath(path: string): boolean {
  return path.includes("[");
}

/** Every route, sections first then their children, in menu order. */
export function allRoutes(): NavRoute[] {
  return SECTIONS.flatMap((section): NavRoute[] => [section, ...section.children]);
}

/** The route with this id, or `undefined`. */
export function findRoute(id: string): NavRoute | undefined {
  return allRoutes().find((route) => route.id === id);
}

/** The section a route belongs to. */
export function sectionOf(id: string): NavSection | undefined {
  return SECTIONS.find((s) => s.id === id || s.children.some((c) => c.id === id));
}

/** May someone with these capabilities see the route (and its section)? */
export function canSeeRoute(id: string, can: CanFn): boolean {
  const route = findRoute(id);
  const section = sectionOf(id);
  if (!route || !section) return false;
  return can(route.capability) && isSectionVisible(section, can);
}

/** PLAN §9.3 "Web dashboard": Owner and Staff. Every web page needs it (linemen are Android-only). */
export const WEB_APP_CAPABILITY: NavCapability = "dashboard.view";

function isSectionVisible(section: NavSection, can: CanFn): boolean {
  return can(WEB_APP_CAPABILITY) && can(section.capability);
}

/** The sections this role sees, in order. */
export function visibleSections(can: CanFn): NavSection[] {
  return SECTIONS.filter((section) => isSectionVisible(section, can));
}

/** The linkable (static) sub-routes of a section this role sees. */
export function visibleChildren(sectionId: NavSectionId, can: CanFn): NavRoute[] {
  const section = sectionOf(sectionId);
  if (!section || !isSectionVisible(section, can)) return [];
  return section.children.filter((c) => !isDynamicPath(c.path) && can(c.capability));
}

/** A menu entry as the client components receive it (label already translated). */
export type NavLink = { id: NavRouteId; href: string; icon: IconName; label: string };

/** Routes → menu entries; `label(id)` is normally `t(\`routes.${id}\`)` of the `shell` namespace. */
export function toNavLinks(
  routes: readonly NavRoute[],
  label: (id: NavRouteId) => string,
): NavLink[] {
  return routes.map((route) => ({
    id: route.id,
    href: route.path,
    icon: route.icon,
    label: label(route.id),
  }));
}

/** Is `pathname` inside the section at `href` (the section's page or any page under it)? */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * How many sections fit in the phone bottom bar before the rest go under "More" (PLAN §12.1).
 * Four slots on a 360px screen (three sections + More): at five slots "Customers" and "Payments"
 * no longer fit in 72px at the smallest type token and were cut off.
 */
export const BOTTOM_BAR_SLOTS = 4;

/** Splits the visible sections into the bottom bar and the "More" list. */
export function splitForBottomBar<T>(links: readonly T[]): { bar: T[]; more: T[] } {
  if (links.length <= BOTTOM_BAR_SLOTS) return { bar: [...links], more: [] };
  return { bar: links.slice(0, BOTTOM_BAR_SLOTS - 1), more: links.slice(BOTTOM_BAR_SLOTS - 1) };
}
