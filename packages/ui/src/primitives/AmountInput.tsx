"use client";

import { type ChangeEvent, type ComponentProps, useState } from "react";
import { cn } from "../lib/cn";
import { paiseToRupeeDigits, parseRupeesInput, type RupeesInputRejectReason } from "../lib/money";
import { focusWithinRing } from "../lib/styles";

export type AmountInputRejectReason = RupeesInputRejectReason;

export type AmountInputProps = Omit<
  ComponentProps<"input">,
  "value" | "defaultValue" | "onChange" | "type" | "inputMode" | "name" | "children"
> & {
  /** Controlled value in integer paise (`null` = empty). Must be whole rupees (a multiple of 100). */
  value?: number | null;
  /** Initial value in integer paise for an uncontrolled field. */
  defaultValue?: number | null;
  /** Called with integer paise (`null` when cleared) after every accepted change. */
  onValueChange?: (paise: number | null) => void;
  /**
   * Called when a change is refused (the field keeps its previous value): a decimal point, a
   * minus sign, other characters, too many digits, or more than `maxPaise`. Use it to show a
   * message in words (i18n), e.g. "Whole rupees only".
   */
  onReject?: (reason: AmountInputRejectReason) => void;
  /**
   * Form field name. The value is submitted in **paise** from a hidden input with this name (the
   * visible rupee field has no name), so a server action reads `formData.get(name)` as paise.
   */
  name?: string;
  /** Largest accepted amount, in paise. */
  maxPaise?: number;
  /** Marks the field as wrong (`aria-invalid`, danger border). */
  invalid?: boolean;
  /** Classes for the bordered wrapper (the `₹` box). */
  className?: string;
};

/**
 * Whole-rupee amount field with a `₹` prefix. Phones show the number pad (`inputMode="numeric"`).
 * Only digits are accepted (grouping commas, spaces and Devanagari digits are normalised); the
 * value comes out as integer paise. Label it with `<label htmlFor>` or `aria-label`.
 */
export function AmountInput({
  value,
  defaultValue = null,
  onValueChange,
  onReject,
  name,
  maxPaise,
  invalid,
  disabled,
  className,
  ...props
}: AmountInputProps) {
  const controlled = value !== undefined;
  const [text, setText] = useState(() => paiseToRupeeDigits(controlled ? value : defaultValue));
  const [lastValue, setLastValue] = useState(value);

  const parsed = parseRupeesInput(text);
  const textPaise = parsed.ok ? parsed.paise : null;

  // A new controlled value from the parent replaces what is shown (React's "adjust state while
  // rendering" pattern), unless it is what the text already says.
  if (controlled && value !== lastValue) {
    setLastValue(value);
    if (value !== textPaise) setText(paiseToRupeeDigits(value));
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const result = parseRupeesInput(event.target.value);
    if (!result.ok) {
      onReject?.(result.reason);
      return;
    }
    if (maxPaise !== undefined && result.paise !== null && result.paise > maxPaise) {
      onReject?.("too-large");
      return;
    }
    setText(result.digits);
    if (result.paise !== textPaise) onValueChange?.(result.paise);
  }

  const shownPaise = controlled ? value : textPaise;

  return (
    <div
      className={cn(
        "flex min-h-touch-min w-full items-center rounded-md border-hairline border-border bg-bg",
        invalid && "border-danger",
        disabled && "bg-surface text-text-muted",
        focusWithinRing,
        className,
      )}
    >
      <span aria-hidden className="pl-3 font-numeric text-lg text-text-muted">
        ₹
      </span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        value={text}
        onChange={handleChange}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className="min-w-0 flex-1 self-stretch rounded-md bg-transparent px-2 font-numeric text-lg text-text outline-hidden disabled:cursor-not-allowed"
        {...props}
      />
      {name ? <input type="hidden" name={name} value={shownPaise ?? ""} /> : null}
    </div>
  );
}
