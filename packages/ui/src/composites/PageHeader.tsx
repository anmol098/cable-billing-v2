import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn";

export type PageHeaderActionPlacement = "responsive" | "inline";

export type PageHeaderProps = Omit<ComponentProps<"header">, "title" | "children"> & {
  /** The page title (an i18n string). Rendered as the page's `<h1>` unless `headingLevel` says otherwise. */
  title: ReactNode;
  /** One short sentence under the title (optional). */
  description?: ReactNode;
  /**
   * The page's one primary action (PLAN §2.2 rule 1, §12.2), usually
   * `<Button size="lg" icon="add">…</Button>` or a `Button asChild` link. A single element:
   * secondary actions belong in the page body, not the header.
   */
  action?: ReactElement;
  /** Something before the title, such as a back link (`<Button variant="quiet" icon="back" asChild>`). */
  back?: ReactNode;
  /**
   * `responsive` (default): the action sits on the right of the title from `sm` up and is pinned
   * to the bottom of the screen on phones, where the thumb reaches. `inline`: always next to the
   * title (for headers inside cards or the /dev/ui showcase).
   */
  actionPlacement?: PageHeaderActionPlacement;
  /** Heading level for the title. Default 1 (one page header per page). */
  headingLevel?: 1 | 2;
  /** Extra classes for the action wrapper, e.g. to lift the pinned bar above a bottom nav. */
  actionClassName?: string;
};

/**
 * Bottom padding for the page body on phones so its end is not hidden under the pinned action
 * (primary-button height + the bar's padding). Put it on the element that wraps the page content.
 */
export const PAGE_ACTION_CLEARANCE = "pb-20 sm:pb-0";

/**
 * The header of every page: the title plus exactly one primary action. On phones the action
 * becomes a full-width bar at the bottom of the screen (give the page body `PAGE_ACTION_CLEARANCE`).
 */
export function PageHeader({
  title,
  description,
  action,
  back,
  actionPlacement = "responsive",
  headingLevel = 1,
  actionClassName,
  className,
  ...props
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const pinned = actionPlacement === "responsive";
  return (
    <header
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {back ? <div className="flex">{back}</div> : null}
        <Heading className="font-sans font-strong text-2xl text-text">{title}</Heading>
        {description ? <p className="text-base text-text-muted">{description}</p> : null}
      </div>
      {action ? (
        <div
          data-slot="page-action"
          className={cn(
            "flex shrink-0 *:w-full sm:*:w-auto",
            pinned &&
              "fixed inset-x-0 bottom-0 z-10 border-t-hairline border-border bg-bg p-4 sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0",
            actionClassName,
          )}
        >
          {action}
        </div>
      ) : null}
    </header>
  );
}
