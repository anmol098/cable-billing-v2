import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { fieldBase } from "../lib/styles";

export type SelectProps = ComponentProps<"select"> & {
  /** Marks the field as wrong (`aria-invalid`, danger border). Show the reason in words nearby. */
  invalid?: boolean;
  /**
   * A first, unselectable option shown while nothing is chosen (an i18n string such as
   * "Choose area"). Pair it with `defaultValue=""` (or `value=""`) and `required`.
   */
  placeholder?: string;
};

/**
 * A dropdown. It is the native `<select>`, so phones open their own big, familiar picker and
 * keyboard/screen-reader support comes from the browser. Pass `<option>` children.
 */
export function Select({ invalid, placeholder, className, children, ...props }: SelectProps) {
  return (
    <select
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cn(fieldBase, "cursor-pointer", className)}
      {...props}
    >
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {children}
    </select>
  );
}
