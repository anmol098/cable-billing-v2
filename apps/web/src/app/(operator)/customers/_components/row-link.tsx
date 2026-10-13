import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * A list row's link: Next.js `Link` without viewport prefetching, so a page of 50 customers
 * doesn't load 50 profiles in the background. The profile still opens client-side on click.
 */
export function RowLink(props: ComponentProps<typeof Link>) {
  return <Link prefetch={false} {...props} />;
}
