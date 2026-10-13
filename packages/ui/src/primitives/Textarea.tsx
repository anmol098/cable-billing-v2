import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { fieldBase } from "../lib/styles";

export type TextareaProps = ComponentProps<"textarea"> & {
  /** Marks the field as wrong (`aria-invalid`, danger border). Show the reason in words nearby. */
  invalid?: boolean;
};

/** A multi-line text field (3 rows by default). */
export function Textarea({ invalid, className, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cn(fieldBase, "py-2", className)}
      {...props}
    />
  );
}
