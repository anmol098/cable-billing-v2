"use client";

/**
 * The customer profile's tab bar (PLAN §12.1): Summary, Connections (VC), Bills, Payments,
 * History. Each tab is its own page (`/customers/[id]`, `/customers/[id]/connections`, …), so the
 * tabs are links; the current one is marked `aria-current="page"`. Scrolls sideways inside its
 * own strip on narrow phones (the page itself never scrolls sideways).
 */
import { cn, focusRing } from "@cb/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { CUSTOMER_TABS, type CustomerTab, customerTabHref } from "./tab-list";

export function CustomerTabs({
  customerId,
  labels,
  label,
}: {
  customerId: string;
  /** The tab words (i18n strings). */
  labels: Readonly<Record<CustomerTab, string>>;
  /** The tab bar's accessible name. */
  label: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1 border-b-hairline border-border">
        {CUSTOMER_TABS.map((tab) => {
          const href = customerTabHref(customerId, tab);
          const current = pathname === href;
          return (
            <li key={tab}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                data-tab={tab}
                className={cn(
                  "flex min-h-touch-min items-center border-b-strong px-4 text-base",
                  current
                    ? "border-accent font-strong text-text"
                    : "border-transparent text-text-muted hover:text-text",
                  focusRing,
                )}
              >
                {labels[tab]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
