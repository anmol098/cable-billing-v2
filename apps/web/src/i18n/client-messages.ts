/**
 * Which messages the root layout's `NextIntlClientProvider` sends to the browser.
 *
 * next-intl 4 passes **every** namespace to client components by default, so each page's payload
 * carries the whole catalogue. Namespaces that only server components read are left out here:
 * `marketing` (T-087: the public pages and the long legal drafts, ~11 kB English / ~22 kB Hindi)
 * would otherwise ride along on every operator page. Server components read all messages through
 * next-intl's request config either way.
 */
export const SERVER_ONLY_NAMESPACES = ["marketing"] as const;

type ServerOnly = (typeof SERVER_ONLY_NAMESPACES)[number];

export function clientMessages<M extends Record<string, unknown>>(
  messages: M,
): Omit<M, ServerOnly> {
  const result: Record<string, unknown> = { ...messages };
  for (const namespace of SERVER_ONLY_NAMESPACES) delete result[namespace];
  return result as Omit<M, ServerOnly>;
}
