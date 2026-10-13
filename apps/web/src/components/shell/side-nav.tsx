"use client";

import { cn, focusRing, Icon } from "@cb/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActivePath, type NavLink } from "@/lib/nav";

/**
 * The desktop sidebar (from `md` up): every section the role may see, icon + word, the current
 * one marked with `aria-current="page"`, bold text and a bar on its edge (never colour alone).
 */
export function SideNav({ links, label }: { links: readonly NavLink[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      data-shell="side-nav"
      className="hidden w-60 shrink-0 flex-col gap-1 border-r-hairline border-border p-3 md:flex"
    >
      <ul className="flex flex-col gap-1">
        {links.map((link) => {
          const active = isActivePath(pathname, link.href);
          return (
            <li key={link.id}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-touch-min items-center gap-3 rounded-md border-l-strong px-3 text-base text-text",
                  active
                    ? "border-accent bg-surface font-strong"
                    : "border-transparent hover:bg-surface",
                  focusRing,
                )}
              >
                <Icon name={link.icon} className="size-6 shrink-0" />
                <span className="min-w-0 truncate">{link.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
