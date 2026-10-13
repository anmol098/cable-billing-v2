/**
 * Placeholder pages (T-029): every route in `@/lib/nav` exists from day one, so feature tasks
 * replace one small `page.tsx` and never touch shared navigation. A placeholder page is two lines:
 *
 * ```tsx
 * import { PlaceholderPage, placeholderMetadata } from "@/components/shell/placeholder-page";
 * export const generateMetadata = () => placeholderMetadata("payments_check");
 * export default function Page() { return <PlaceholderPage route="payments_check" />; }
 * ```
 *
 * It checks the session (`getTenantContext()`), answers 404 when the role may not see the route
 * (the same capability as the menu), and shows the title + "Coming soon", plus the section's
 * pages when the route is a section.
 */
import { EmptyState } from "@cb/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantContext } from "@/lib/auth/session";
import {
  canSeeRoute,
  findRoute,
  type NavRouteId,
  type NavSectionId,
  sectionOf,
  toNavLinks,
  visibleChildren,
} from "@/lib/nav";
import { roleCan } from "./access";
import { SectionMenu } from "./section-menu";
import { ShellPageHeader } from "./shell-page-header";

/** `<title>` of a route's page: its menu word. */
export async function placeholderMetadata(route: NavRouteId): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t(`routes.${route}`) };
}

/** The signed-in role's `can`, after a 404 for a route it may not see. */
async function requireRoute(route: NavRouteId) {
  const ctx = await getTenantContext();
  const can = roleCan(ctx.role);
  if (!canSeeRoute(route, can)) notFound();
  return can;
}

/** The section's pages the role may open, as menu links. */
async function sectionLinks(section: NavSectionId, can: ReturnType<typeof roleCan>) {
  const t = await getTranslations("shell");
  return toNavLinks(visibleChildren(section, can), (id) => t(`routes.${id}`));
}

/** "Coming soon" for `route`, which a feature task replaces. */
export async function PlaceholderPage({ route }: { route: NavRouteId }) {
  const can = await requireRoute(route);
  const t = await getTranslations("shell");
  const section = sectionOf(route);
  const isSection = section?.id === route;
  const links = section && isSection ? await sectionLinks(section.id, can) : [];
  return (
    <div className="flex flex-col gap-6" data-placeholder={route}>
      <ShellPageHeader title={t(`routes.${route}`)} />
      <EmptyState icon={findRoute(route)?.icon ?? "settings"} message={t("coming_soon")} />
      {section ? (
        <SectionMenu
          links={links}
          label={t("section_pages", { section: t(`routes.${section.id}`) })}
        />
      ) : null}
    </div>
  );
}

/**
 * A section whose own page is only its list of pages (Settings, Reports): the title and one big
 * row per page the role may open. Not a placeholder; it stays when the sub-pages are built.
 */
export async function SectionIndexPage({ section }: { section: NavSectionId }) {
  const can = await requireRoute(section);
  const t = await getTranslations("shell");
  const title = t(`routes.${section}`);
  return (
    <div className="flex flex-col gap-6" data-section-index={section}>
      <ShellPageHeader title={title} />
      <SectionMenu
        links={await sectionLinks(section, can)}
        label={t("section_pages", { section: title })}
      />
    </div>
  );
}
