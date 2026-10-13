import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

export type CheckboxProps = Omit<ComponentProps<"input">, "type" | "children"> & {
  /** The visible word(s) next to the box; clicking them toggles it. */
  label: ReactNode;
  /** A short hint under the label, read as the checkbox's description. */
  description?: ReactNode;
  /** Classes for the clickable row (the `<label>`); `className` goes to the row too. */
  className?: string;
};

/**
 * A native checkbox inside a full-height clickable row (at least touch-min tall), so the whole
 * label is the tap target. Ticked colour is the accent token.
 */
export function Checkbox({ label, description, className, id, disabled, ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const labelId = `${inputId}-label`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        "flex min-h-touch-min cursor-pointer gap-3 py-2 font-sans text-base text-text",
        description ? "items-start" : "items-center",
        disabled && "cursor-not-allowed text-text-muted",
        className,
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        disabled={disabled}
        // The name is the label word only; the hint is the description (both sit in the <label>).
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className={cn(
          "size-5 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed",
          description && "mt-0.5",
          focusRing,
        )}
        {...props}
      />
      <span className="flex flex-col gap-1">
        <span id={labelId}>{label}</span>
        {description ? (
          <span id={descriptionId} className="text-sm text-text-muted">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
