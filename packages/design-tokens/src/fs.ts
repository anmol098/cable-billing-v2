/** File-system side of the pipeline (Node only; not exported from the package index). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GeneratedFile, renderOutputs } from "./outputs";
import { parseTokens, type Tokens } from "./schema";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const TOKENS_PATH = fileURLToPath(new URL("../tokens.json", import.meta.url));

/** Reads and validates tokens.json. Throws on invalid JSON or invalid tokens. */
export function loadTokens(path: string = TOKENS_PATH): Tokens {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  return parseTokens(raw);
}

export type FileStatus = { path: string; status: "unchanged" | "changed" | "missing" };

/** Compares each generated file with the one on disk (paths relative to `root`). */
export function compareOutputs(files: readonly GeneratedFile[], root = REPO_ROOT): FileStatus[] {
  return files.map(({ path, content }) => {
    const target = join(root, path);
    if (!existsSync(target)) return { path, status: "missing" };
    return { path, status: readFileSync(target, "utf8") === content ? "unchanged" : "changed" };
  });
}

/** Writes the files that differ from disk. Returns the status of every file before writing. */
export function writeOutputs(files: readonly GeneratedFile[], root = REPO_ROOT): FileStatus[] {
  const statuses = compareOutputs(files, root);
  files.forEach(({ path, content }, index) => {
    if (statuses[index]?.status === "unchanged") return;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  });
  return statuses;
}

/** tokens.json → every generated file, in memory. */
export function generate(tokensPath: string = TOKENS_PATH): GeneratedFile[] {
  return renderOutputs(loadTokens(tokensPath));
}
