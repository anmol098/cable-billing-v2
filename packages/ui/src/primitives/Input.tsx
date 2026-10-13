import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { fieldBase } from "../lib/styles";

export type InputProps = ComponentProps<"input"> & {
  /** Marks the field as wrong (`aria-invalid`, danger border). Show the reason in words nearby. */
  invalid?: boolean;
};

/** A single-line text field. Label it with a `<label htmlFor>` (or `aria-label`). */
export function Input({ invalid, className, type = "text", ...props }: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cn(fieldBase, className)}
      {...props}
    />
  );
}
