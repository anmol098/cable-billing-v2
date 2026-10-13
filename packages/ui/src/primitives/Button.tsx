import { Slot, Slottable } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
/** `md`: touch-min height (forms, rows). `lg`: primary-button height (the one main action). */
export type ButtonSize = "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-accent bg-accent text-on-accent",
  secondary: "border-border bg-bg text-text hover:bg-surface",
  quiet: "border-transparent bg-transparent text-text hover:bg-surface",
  danger: "border-danger bg-danger text-on-accent",
};

const SIZE: Record<ButtonSize, string> = {
  md: "min-h-touch-min px-4 text-base",
  lg: "min-h-primary-button px-6 text-lg",
};

/** Disabled look, token colours only (no opacity). Not applied while `loading`. */
const DISABLED = "disabled:border-border disabled:bg-surface disabled:text-text-muted";

/** The class string for a button of this variant and size (also used by IconButton). */
export function buttonClasses({
  variant = "primary",
  size = "md",
  loading = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex cursor-pointer select-none items-center justify-center gap-2 rounded-md border-hairline",
    "font-sans font-strong disabled:cursor-not-allowed",
    focusRing,
    VARIANT[variant],
    SIZE[size],
    loading ? "cursor-wait disabled:cursor-wait" : DISABLED,
    className,
  );
}

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon before the word (PLAN §2.2: actions are icon + colour + word). Decorative. */
  icon?: IconName;
  /**
   * Shows a spinner instead of the icon, disables the button and sets `aria-busy`. The button
   * keeps its colours so it doesn't look broken while saving.
   */
  loading?: boolean;
  /** Text shown instead of the children while loading (an i18n string such as "Saving…"). */
  loadingLabel?: string;
  /**
   * Style the single child element instead of rendering a `<button>`, e.g. a Next.js `<Link>`.
   * `icon` still renders before the child's content; `loading`/`loadingLabel` don't apply.
   */
  asChild?: boolean;
};

/**
 * The action button. One `primary` per screen (PLAN §2.2 rule 1); `secondary` for other actions,
 * `quiet` for low-emphasis ones, `danger` for reversals and other destructive steps.
 */
export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  loadingLabel,
  asChild = false,
  disabled,
  className,
  children,
  type,
  ...props
}: ButtonProps) {
  const adornment = loading ? <Spinner /> : icon ? <Icon name={icon} className="shrink-0" /> : null;

  if (asChild) {
    return (
      <Slot className={buttonClasses({ variant, size, className })} {...props}>
        {adornment}
        <Slottable>{children}</Slottable>
      </Slot>
    );
  }

  return (
    <button
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, loading, className })}
      {...props}
    >
      {adornment}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
