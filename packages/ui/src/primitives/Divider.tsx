import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export type DividerProps = Omit<ComponentProps<"hr">, "children" | "role"> & {
  orientation?: "horizontal" | "vertical";
  /**
   * Purely visual (default): hidden from screen readers. Set `false` when the line separates
   * sections that matter for meaning; it is then announced as a `separator`.
   */
  decorative?: boolean;
};

/** A hairline in the border colour. Vertical dividers stretch to the height of a flex row. */
export function Divider({
  orientation = "horizontal",
  decorative = true,
  className,
  ...props
}: DividerProps) {
  const vertical = orientation === "vertical";
  const classes = cn(
    "m-0 shrink-0 border-0 border-border",
    vertical ? "h-auto self-stretch border-l-hairline" : "w-full border-t-hairline",
    className,
  );
  return (
    <hr
      aria-hidden={decorative || undefined}
      aria-orientation={decorative ? undefined : orientation}
      data-orientation={orientation}
      className={classes}
      {...props}
    />
  );
}
