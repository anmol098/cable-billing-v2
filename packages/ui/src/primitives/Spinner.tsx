import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { VisuallyHidden } from "./VisuallyHidden";

export type SpinnerSize = "sm" | "md" | "lg";

export type SpinnerProps = Omit<ComponentProps<"span">, "children"> & {
  /**
   * What is loading, for screen readers (an i18n string such as t("common.loading")). With a label
   * the spinner is a `role="status"` live region; without one it is decorative (`aria-hidden`),
   * e.g. inside a Button that already says what is happening.
   */
  label?: string;
  size?: SpinnerSize;
};

const SIZE: Record<SpinnerSize, string> = { sm: "size-4", md: "size-6", lg: "size-10" };

/** A turning ring in the current text colour. */
export function Spinner({ label, size = "sm", className, ...props }: SpinnerProps) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex shrink-0 items-center", className)}
      {...props}
    >
      <span
        aria-hidden
        data-spinner=""
        className={cn(
          "inline-block animate-spin rounded-full border-strong border-current border-t-transparent",
          SIZE[size],
        )}
      />
      {label ? <VisuallyHidden>{label}</VisuallyHidden> : null}
    </span>
  );
}
