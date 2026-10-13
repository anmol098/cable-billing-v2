import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";

export type EmptyStateProps = Omit<ComponentProps<"div">, "children"> & {
  /** What is empty (e.g. `customer`, `bill`, `search`). Decorative: the sentence says it in words. */
  icon: IconName;
  /** One plain sentence (an i18n string): what is missing and what to do. */
  message: ReactNode;
  /** The one next step, usually a `Button` (e.g. "Add customer"). */
  action?: ReactElement;
};

/** Shown instead of an empty list: icon + one sentence + one action. */
export function EmptyState({ icon, message, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-4 rounded-lg border-hairline border-border bg-bg px-4 py-8 text-center",
        className,
      )}
      {...props}
    >
      <Icon name={icon} className="size-10 text-text-muted" />
      <p className="text-lg text-text">{message}</p>
      {action ?? null}
    </div>
  );
}
