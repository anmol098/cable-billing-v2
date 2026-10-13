import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export type CardProps = ComponentProps<"div"> & {
  /** Render the child element (e.g. `<section>`, `<article>`, a `<Link>`) with the card styles. */
  asChild?: boolean;
};

/** A box on the page background with a hairline border and no elevation (hyper-minimal). */
export function Card({ asChild = false, className, ...props }: CardProps) {
  const Component = asChild ? Slot : "div";
  return (
    <Component
      className={cn("block rounded-lg border-hairline border-border bg-bg p-4", className)}
      {...props}
    />
  );
}
