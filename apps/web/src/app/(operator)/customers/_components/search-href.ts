/** The list URL for these values (empty ones left out). Shared by the server page and the form. */
export function searchHref(pathname: string, values: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value.trim() !== "") params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
