import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export type VisuallyHiddenProps = ComponentProps<"span"> & {
  /** Render the child element instead of a `<span>` (e.g. a `<h2>` that only screen readers need). */
  asChild?: boolean;
};

/** Content for screen readers only: hidden visually, still in the accessibility tree. */
export function VisuallyHidden({ asChild = false, className, ...props }: VisuallyHiddenProps) {
  const Component = asChild ? Slot : "span";
  return <Component className={cn("sr-only", className)} {...props} />;
}
