import { cn, PageHeader, type PageHeaderProps } from "@cb/ui";
import { PAGE_ACTION_ABOVE_NAV } from "./layout-classes";

/**
 * T-007's `PageHeader` for pages inside the operator shell: on phones its pinned primary action
 * sits just above the bottom bar instead of under it. Use it for every operator page header, and
 * give the page body `PAGE_ACTION_CLEARANCE` from `@cb/ui` when there is an action.
 */
export function ShellPageHeader({ actionClassName, ...props }: PageHeaderProps) {
  return <PageHeader actionClassName={cn(PAGE_ACTION_ABOVE_NAV, actionClassName)} {...props} />;
}
