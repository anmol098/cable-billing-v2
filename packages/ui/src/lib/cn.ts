import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * Token names as they appear in the generated theme.css (packages/design-tokens/tokens.json).
 * tailwind-merge has to know them: by default it treats any unknown `text-*` as a colour, so
 * `cn("text-amount", "text-cash")` would drop the size. cn.test.ts fails if these lists drift from
 * theme.css, so a new token only needs adding here.
 */
export const THEME_COLORS = [
  "bg",
  "surface",
  "text",
  "text-muted",
  "border",
  "accent",
  "on-accent",
  "focus",
  "cash",
  "upi",
  "pending",
  "success",
  "danger",
  "due",
  "credit",
] as const;
export const THEME_TEXT_SIZES = ["sm", "base", "lg", "xl", "2xl", "amount"] as const;
export const THEME_FONTS = ["sans", "numeric"] as const;
export const THEME_FONT_WEIGHTS = ["regular", "strong"] as const;
export const THEME_RADII = ["none", "sm", "md", "lg", "full"] as const;
export const THEME_SIZES = ["touch-min", "primary-button", "icon", "icon-large"] as const;
export const THEME_BORDER_WIDTHS = ["hairline", "strong"] as const;

const borderWidths = [...THEME_BORDER_WIDTHS];

const twMerge = extendTailwindMerge({
  override: {
    theme: {
      color: [...THEME_COLORS],
      text: [...THEME_TEXT_SIZES],
      font: [...THEME_FONTS],
      "font-weight": [...THEME_FONT_WEIGHTS],
      radius: [...THEME_RADII],
    },
  },
  extend: {
    theme: { spacing: [...THEME_SIZES] },
    classGroups: {
      "border-w": [{ border: borderWidths }],
      "border-w-x": [{ "border-x": borderWidths }],
      "border-w-y": [{ "border-y": borderWidths }],
      "border-w-t": [{ "border-t": borderWidths }],
      "border-w-r": [{ "border-r": borderWidths }],
      "border-w-b": [{ "border-b": borderWidths }],
      "border-w-l": [{ "border-l": borderWidths }],
    },
  },
});

/**
 * Joins class names (clsx syntax: strings, arrays, `{ class: condition }`) and resolves Tailwind
 * conflicts so the last one wins: `cn("text-text", isDue && "text-due")`. Knows the token names, so
 * a size (`text-amount`) never removes a colour (`text-cash`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
