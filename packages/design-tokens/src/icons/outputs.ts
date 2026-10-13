import type { GeneratedFile } from "../outputs";
import { ANDROID_DRAWABLE_DIR, renderVectorDrawable } from "./android";
import { androidDrawableName, type IconManifest, IconManifestError } from "./manifest";
import { REACT_ICONS_PATH, renderReactIcons } from "./react";
import type { IconNode } from "./svg";

export const LUCIDE_LICENSE_PATH = "packages/ui/src/icons/LICENSE-lucide.txt";

/** What the generator needs from the lucide-static package. */
export type LucideData = {
  version: string;
  /** Canonical Lucide name → elements (lucide-static's `icon-nodes.json`). */
  nodes: Readonly<Record<string, IconNode>>;
  /** lucide-static's LICENSE text (ISC, plus MIT for the Feather-derived icons). */
  license: string;
};

/** Repo-relative path of the Android drawable for a semantic icon name. */
export function androidDrawablePath(name: string): string {
  return `${ANDROID_DRAWABLE_DIR}/${androidDrawableName(name)}.xml`;
}

/** Every file generated from icons.json: the React icon data, its licence, one drawable per icon. */
export function renderIconOutputs(manifest: IconManifest, lucide: LucideData): GeneratedFile[] {
  const missing = manifest.filter(({ lucide: name }) => !Object.hasOwn(lucide.nodes, name));
  if (missing.length > 0) {
    throw new IconManifestError(
      missing.map(
        ({ name, lucide: icon }) =>
          `${name}: "${icon}" is not a Lucide icon in lucide-static ${lucide.version} (use the canonical name from lucide.dev; old aliases are not accepted)`,
      ),
    );
  }
  const icons = manifest.map(({ name, lucide: icon }) => ({
    name,
    lucide: icon,
    node: lucide.nodes[icon] ?? [],
  }));
  return [
    { path: REACT_ICONS_PATH, content: renderReactIcons(icons, lucide.version) },
    { path: LUCIDE_LICENSE_PATH, content: lucide.license },
    ...icons.map(({ name, lucide: icon, node }) => ({
      path: androidDrawablePath(name),
      content: renderVectorDrawable({ name, lucide: icon, version: lucide.version }, node),
    })),
  ];
}
