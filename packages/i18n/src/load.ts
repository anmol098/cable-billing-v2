import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue, RawCatalog } from "./catalog";
import { LOCALES } from "./locales";

/**
 * Reads `<messagesDir>/<locale>/<namespace>.json` for every locale.
 * Node-only: not exported from the package entry so web bundles never pull in `node:fs`.
 */
export function loadRawCatalog(messagesDir: string): { raw: RawCatalog; errors: Issue[] } {
  const errors: Issue[] = [];
  const raw = Object.fromEntries(LOCALES.map((l) => [l, {}])) as RawCatalog;
  for (const locale of LOCALES) {
    const dir = join(messagesDir, locale);
    if (!existsSync(dir)) {
      errors.push({ file: `${locale}/`, message: "locale folder is missing" });
      continue;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const namespace = entry.name.slice(0, -".json".length);
      try {
        raw[locale][namespace] = JSON.parse(readFileSync(join(dir, entry.name), "utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ file: `${locale}/${entry.name}`, message: `invalid JSON: ${message}` });
      }
    }
  }
  return { raw, errors };
}
