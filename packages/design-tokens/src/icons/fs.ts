/** File-system side of the icon pipeline (Node only; not exported from the package index). */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareOutputs, type FileStatus, REPO_ROOT, writeOutputs } from "../fs";
import type { GeneratedFile } from "../outputs";
import { ANDROID_DRAWABLE_DIR } from "./android";
import { type IconManifest, parseIconManifest } from "./manifest";
import { type LucideData, renderIconOutputs } from "./outputs";
import type { IconNode } from "./svg";

export const ICONS_PATH = fileURLToPath(new URL("../../icons.json", import.meta.url));

/** Reads and validates icons.json. */
export function loadIconManifest(path: string = ICONS_PATH): IconManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  return parseIconManifest(raw);
}

/** Reads the installed lucide-static package (no network). */
export function loadLucide(): LucideData {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("lucide-static/package.json"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const nodes = JSON.parse(readFileSync(join(root, "icon-nodes.json"), "utf8")) as Record<
    string,
    IconNode
  >;
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  return {
    version: pkg.version,
    nodes,
    license: license.endsWith("\n") ? license : `${license}\n`,
  };
}

/** icons.json + lucide-static → every generated icon file, in memory. */
export function generateIcons(path: string = ICONS_PATH): GeneratedFile[] {
  return renderIconOutputs(loadIconManifest(path), loadLucide());
}

export type IconFileStatus = FileStatus | { path: string; status: "extra" };

/**
 * `ic_cb_*.xml` drawables on disk that icons.json no longer produces. The generator owns the
 * `ic_cb_` prefix, so these are leftovers of removed or renamed icons.
 */
export function extraDrawables(files: readonly GeneratedFile[], root = REPO_ROOT): string[] {
  const dir = join(root, ANDROID_DRAWABLE_DIR);
  if (!existsSync(dir)) return [];
  const expected = new Set(files.map((file) => file.path));
  return readdirSync(dir)
    .filter((file) => /^ic_cb_.*\.xml$/.test(file))
    .map((file) => `${ANDROID_DRAWABLE_DIR}/${file}`)
    .filter((path) => !expected.has(path))
    .sort();
}

/** Status of every generated file, plus leftover drawables as `extra`. */
export function compareIconOutputs(
  files: readonly GeneratedFile[],
  root = REPO_ROOT,
): IconFileStatus[] {
  return [
    ...compareOutputs(files, root),
    ...extraDrawables(files, root).map((path) => ({ path, status: "extra" as const })),
  ];
}

/** Writes changed or missing files and deletes leftover drawables. Returns the status before. */
export function writeIconOutputs(
  files: readonly GeneratedFile[],
  root = REPO_ROOT,
): IconFileStatus[] {
  const extra = extraDrawables(files, root);
  for (const path of extra) rmSync(join(root, path));
  return [
    ...writeOutputs(files, root),
    ...extra.map((path) => ({ path, status: "extra" as const })),
  ];
}
