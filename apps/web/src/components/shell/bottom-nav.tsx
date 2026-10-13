"use client";

import { cn, focusRing, Icon, type IconName } from "@cb/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useId, useRef, useState } from "react";
import { isActivePath, type NavLink, splitForBottomBar } from "@/lib/nav";
import { BOTTOM_BAR_HEIGHT } from "./layout-classes";
import { useDismiss } from "./use-dismiss";

const ITEM = cn(
  "flex h-full min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-t-strong px-1 text-sm",
  focusRing,
);

function itemState(active: boolean): string {
  return active
    ? "border-accent font-strong text-text"
    : "border-transparent text-text-muted hover:text-text";
}

function ItemContent({ icon, label }: { icon: IconName; label: string }) {
  return (
    <>
      <Icon name={icon} className="size-6 shrink-0" />
      <span className="w-full truncate text-center">{label}</span>
    </>
  );
}

/**
 * The phone navigation (under `md`): a bar fixed to the bottom of the screen with up to four
 * sections and "More", which opens the rest as a list just above the bar (PLAN §12.1).
 */
export function BottomNav({
  links,
  label,
  moreLabel,
  moreMenuLabel,
}: {
  links: readonly NavLink[];
  /** The nav landmark's name ("Main menu"). */
  label: string;
  /** The "More" button's word. */
  moreLabel: string;
  /** The list's accessible name ("More pages"). */
  moreMenuLabel: string;
}) {
  const pathname = usePathname();
  const { bar, more } = splitForBottomBar(links);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const container = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useDismiss(open, close, container, trigger);
  const moreActive = more.some((link) => isActivePath(pathname, link.href));

  return (
    <nav
      ref={container}
      aria-label={label}
      data-shell="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-20 border-t-hairline border-border bg-bg md:hidden"
    >
      {open ? (
        <ul
          id={listId}
          aria-label={moreMenuLabel}
          className="absolute inset-x-0 bottom-full flex flex-col gap-1 border-t-hairline border-border bg-bg p-2"
        >
          {more.map((link) => {
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
      ) : null}
      <ul className={cn("flex", BOTTOM_BAR_HEIGHT)}>
        {bar.map((link) => {
          const active = isActivePath(pathname, link.href);
          return (
            <li key={link.id} className="flex min-w-0 flex-1">
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(ITEM, itemState(active))}
              >
                <ItemContent icon={link.icon} label={link.label} />
              </Link>
            </li>
          );
        })}
        {more.length > 0 ? (
          <li className="flex min-w-0 flex-1">
            <button
              ref={trigger}
              type="button"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              data-active={moreActive || undefined}
              onClick={() => setOpen((value) => !value)}
              className={cn(ITEM, itemState(moreActive || open))}
            >
              <ItemContent icon="more" label={moreLabel} />
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
