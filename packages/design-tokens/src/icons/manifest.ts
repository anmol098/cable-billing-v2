/**
 * icons.json: semantic icon name → Lucide icon name.
 *
 *   { "cash": "banknote", "whatsapp": "message-circle", … }
 *
 * The semantic name is what the apps use (`<Icon name="cash" />`, `R.drawable.ic_cb_cash`).
 * The Lucide name is the canonical name in lucide-static's `icon-nodes.json` (no deprecated aliases).
 */

/** Semantic names: lowercase kebab-case (`cash`, `log-out`). Becomes snake_case on Android. */
export const ICON_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Lucide names are kebab-case too (`circle-check`, `volume-2`). */
const LUCIDE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Semantic name → Lucide name, in the order of icons.json. */
export type IconManifest = ReadonlyArray<{ readonly name: string; readonly lucide: string }>;

export class IconManifestError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], source = "icons.json") {
    super(`${source} is invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "IconManifestError";
    this.issues = issues;
  }
}

/** Validates the parsed icons.json. Throws an `IconManifestError` listing every problem. */
export function parseIconManifest(input: unknown): IconManifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new IconManifestError(['must be an object of "semantic-name": "lucide-name" pairs']);
  }
  const issues: string[] = [];
  const entries: { name: string; lucide: string }[] = [];
  for (const [name, lucide] of Object.entries(input)) {
    if (!ICON_NAME.test(name)) {
      issues.push(
        `${name}: icon names must be lowercase kebab-case (letters and digits, start with a letter)`,
      );
    }
    if (typeof lucide !== "string" || !LUCIDE_NAME.test(lucide)) {
      issues.push(`${name}: the value must be a Lucide icon name such as "banknote"`);
      continue;
    }
    entries.push({ name, lucide });
  }
  if (Object.keys(input).length === 0) issues.push("must list at least one icon");
  if (issues.length > 0) throw new IconManifestError(issues);
  return entries;
}

/** `log-out` → `ic_cb_log_out` (Android resource names allow only `[a-z0-9_]`). */
export function androidDrawableName(name: string): string {
  return `ic_cb_${name.replaceAll("-", "_")}`;
}
