/** The customer profile's tabs and their URLs (plain module: server and client components use it). */
export const CUSTOMER_TABS = ["summary", "connections", "bills", "payments", "history"] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

/** The URL of a tab. */
export function customerTabHref(customerId: string, tab: CustomerTab): string {
  return tab === "summary" ? `/customers/${customerId}` : `/customers/${customerId}/${tab}`;
}
