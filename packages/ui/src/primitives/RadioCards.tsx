"use client";

import * as RadioGroup from "@radix-ui/react-radio-group";
import type { ComponentProps, ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

export type RadioCardOption = {
  value: string;
  /** The visible word(s) on the tile. */
  label: ReactNode;
  /** A short second line (e.g. a price or an explanation). */
  description?: ReactNode;
  /** Semantic icon before the label (e.g. `cash` / `upi` for a payment method). */
  icon?: IconName;
  /** Colour for the icon, a token utility such as `text-cash` (PLAN §2.2 fixed colours). */
  iconClassName?: string;
  disabled?: boolean;
};

export type RadioCardsProps = Omit<
  ComponentProps<typeof RadioGroup.Root>,
  "children" | "asChild" | "dir"
> & {
  options: readonly RadioCardOption[];
};

/**
 * Pick one of a few big option tiles (Radix RadioGroup: arrow keys move and select, Tab leaves the
 * group). Name the group with `aria-label` or `aria-labelledby`. Lay the tiles out with
 * `className` (default: one column; e.g. `sm:grid-cols-2`). Works in forms via `name`/`required`.
 */
export function RadioCards({ options, className, ...props }: RadioCardsProps) {
  return (
    <RadioGroup.Root className={cn("grid gap-3", className)} {...props}>
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            "group flex min-h-touch-min w-full cursor-pointer items-center gap-3 rounded-lg",
            "border-strong border-border bg-bg p-4 text-left font-sans text-base text-text",
            "aria-checked:border-accent",
            "disabled:cursor-not-allowed disabled:bg-surface disabled:text-text-muted",
            focusRing,
          )}
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-full border-strong border-text-muted group-aria-checked:border-accent"
          >
            <RadioGroup.Indicator className="size-2.5 rounded-full bg-accent" />
          </span>
          {option.icon ? (
            <Icon name={option.icon} className={cn("size-6 shrink-0", option.iconClassName)} />
          ) : null}
          <span className="flex flex-col gap-1">
            <span className="font-strong">{option.label}</span>
            {option.description ? (
              <span className="text-sm text-text-muted">{option.description}</span>
            ) : null}
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
