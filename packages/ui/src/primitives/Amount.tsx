import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { formatRupees } from "../lib/money";

/**
 * - `neutral`: plain text colour.
 * - `balance`: a customer balance; more than zero is money due (red), zero is neutral.
 * - `due` / `credit`: force that meaning.
 *
 * Whatever the tone, a negative amount is a credit (the customer paid extra): it is shown as the
 * positive amount in the credit colour, never with a minus sign.
 */
export type AmountTone = "neutral" | "balance" | "due" | "credit";
export type AmountSize = "sm" | "base" | "lg" | "xl" | "2xl" | "amount";

export type AmountProps = Omit<ComponentProps<"span">, "children"> & {
  /** Integer paise (number or bigint). */
  paise: number | bigint;
  tone?: AmountTone;
  /** Type token; `amount` is the big number on a screen. Default `base`. */
  size?: AmountSize;
  weight?: "regular" | "strong";
  /**
   * The word shown after a due amount (an i18n string such as "Due"). PLAN §2.2: never colour
   * alone, so pass it wherever a due amount can appear without other words around it.
   */
  dueLabel?: string;
  /** The word shown after a credit amount (e.g. "Credit"). Pass it whenever `paise` can be negative. */
  creditLabel?: string;
};

type ResolvedTone = "neutral" | "due" | "credit";

const TONE: Record<ResolvedTone, string> = {
  neutral: "text-text",
  due: "text-due",
  credit: "text-credit",
};

/** Full class names, so Tailwind's source scan finds them. */
const SIZE: Record<AmountSize, string> = {
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
  "2xl": "text-2xl",
  amount: "text-amount",
};

/** A label is smaller than its amount, so a big number stays the biggest thing. */
const LABEL_SIZE: Record<AmountSize, string> = {
  sm: "text-sm",
  base: "text-sm",
  lg: "text-base",
  xl: "text-base",
  "2xl": "text-lg",
  amount: "text-lg",
};

export function resolveAmountTone(paise: number | bigint, tone: AmountTone): ResolvedTone {
  const sign = typeof paise === "bigint" ? paise : BigInt(paise);
  if (sign < 0n) return "credit";
  if (tone === "balance") return sign > 0n ? "due" : "neutral";
  return tone;
}

/**
 * A rupee amount: `₹1,23,456` with Indian grouping and tabular figures (`font-numeric`), so columns
 * of amounts line up. Paise appear only when the amount is not whole rupees (`₹12.50`).
 */
export function Amount({
  paise,
  tone = "neutral",
  size = "base",
  weight = "strong",
  dueLabel,
  creditLabel,
  className,
  ...props
}: AmountProps) {
  const { text } = formatRupees(paise);
  const resolved = resolveAmountTone(paise, tone);
  const label = resolved === "due" ? dueLabel : resolved === "credit" ? creditLabel : undefined;
  return (
    <span
      data-tone={resolved}
      className={cn(
        "inline-flex items-baseline gap-2",
        TONE[resolved],
        weight === "strong" ? "font-strong" : "font-regular",
        className,
      )}
      {...props}
    >
      <span className={cn("font-numeric", SIZE[size])}>{text}</span>
      {label ? <span className={cn("font-sans", LABEL_SIZE[size])}>{label}</span> : null}
    </span>
  );
}
