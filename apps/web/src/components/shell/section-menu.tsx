import { cn, focusRing, Icon } from "@cb/ui";
import Link from "next/link";
import type { NavLink } from "@/lib/nav";

/**
 * The pages of a section as a list of big rows (icon + word + arrow): the Settings and Reports
 * pages, and under each section's placeholder until its feature task replaces it.
 */
export function SectionMenu({ links, label }: { links: readonly NavLink[]; label: string }) {
  if (links.length === 0) return null;
  return (
    <nav aria-label={label} data-shell="section-menu">
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.id}>
            <Link
              href={link.href}
              className={cn(
                "flex min-h-primary-button items-center gap-3 rounded-lg border-hairline border-border bg-bg px-4 py-3 text-lg text-text hover:bg-surface",
                focusRing,
              )}
            >
              <Icon name={link.icon} className="size-6 shrink-0" />
              <span className="min-w-0 flex-1">{link.label}</span>
              <Icon name="next" className="size-5 shrink-0 text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
