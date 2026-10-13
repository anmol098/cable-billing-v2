/**
 * Finds every service and every isolation case set in a source tree, by importing the modules
 * (Vitest only). Services are exported values made by `defineService`; case sets are exported from
 * `*.isolation.ts` files.
 *
 * Scanned: every `.ts` file under the root except tests (`*.test.ts`), declarations (`*.d.ts`) and
 * the root's own `testing/` folder (the harness and its fixtures). So **core modules must be free
 * of import-time side effects** (no env reads, no connections at import): use factories.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AnyService, isService } from "../context/service";
import { type IsolationCaseSet, isIsolationCaseSet } from "./isolation";

/** `packages/core/src`. */
export const CORE_SOURCE_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface DiscoveredService {
  readonly service: AnyService;
  /** Path relative to the root, with `/`. */
  readonly file: string;
  readonly exportName: string;
}

export interface DiscoveredCaseSet {
  readonly set: IsolationCaseSet;
  readonly file: string;
  readonly exportName: string;
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      if (rel === "testing" || entry.name === "node_modules") continue;
      walk(path, root, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(rel);
    }
  }
}

/** Source modules under `root` (relative paths, sorted), tests and `testing/` excluded. */
export function listModules(root: string): string[] {
  const files: string[] = [];
  walk(root, root, files);
  return files.sort();
}

async function exportsOf(root: string, file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(join(root, file)).href)) as Record<string, unknown>;
}

/** Every service exported by a module under `root` (each service once, first export wins). */
export async function discoverServices(
  root: string = CORE_SOURCE_DIR,
): Promise<DiscoveredService[]> {
  const seen = new Set<AnyService>();
  const found: DiscoveredService[] = [];
  for (const file of listModules(root)) {
    if (file.endsWith(".isolation.ts")) continue;
    for (const [exportName, value] of Object.entries(await exportsOf(root, file))) {
      if (isService(value) && !seen.has(value)) {
        seen.add(value);
        found.push({ service: value, file, exportName });
      }
    }
  }
  return found;
}

/** Every isolation case set exported by a `*.isolation.ts` module under `root`. */
export async function discoverIsolationCaseSets(
  root: string = CORE_SOURCE_DIR,
): Promise<DiscoveredCaseSet[]> {
  const found: DiscoveredCaseSet[] = [];
  for (const file of listModules(root)) {
    if (!file.endsWith(".isolation.ts")) continue;
    for (const [exportName, value] of Object.entries(await exportsOf(root, file))) {
      if (isIsolationCaseSet(value)) found.push({ set: value, file, exportName });
    }
  }
  return found;
}
