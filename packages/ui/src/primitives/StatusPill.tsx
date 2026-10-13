import type { ComponentProps } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";

/** The fixed meanings from PLAN §2.2 rule 4 (same colour + icon on web and Android). */
export type StatusPillVariant = "cash" | "upi" | "pending" | "success" | "danger";

export const STATUS_PILL_STYLES: Record<StatusPillVariant, { icon: IconName; className: string }> =
  {
    cash: { icon: "cash", className: "text-cash" },
    upi: { icon: "upi", className: "text-upi" },
    pending: { icon: "pending", className: "text-pending" },
    success: { icon: "success", className: "text-success" },
    danger: { icon: "danger", className: "text-danger" },
  };

export type StatusPillProps = Omit<ComponentProps<"span">, "children"> & {
  variant: StatusPillVariant;
  /** The short word (an i18n string, e.g. "Saved on phone"). Required: never colour alone. */
  label: string;
  /** Override the variant's icon (keep the meaning: same colour family, same idea). */
  icon?: IconName;
};

/** A status: icon + colour + word, in a hairline pill. */
export function StatusPill({ variant, label, icon, className, ...props }: StatusPillProps) {
  const style = STATUS_PILL_STYLES[variant];
  return (
    <span
      data-variant={variant}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border-hairline border-current bg-bg px-3 py-1",
        "font-sans text-sm font-strong",
        style.className,
        className,
      )}
      {...props}
    >
      <Icon name={icon ?? style.icon} className="shrink-0" />
      <span>{label}</span>
    </span>
  );
}
