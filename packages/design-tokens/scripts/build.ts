/**
 * tokens.json → packages/ui/src/theme.css + apps/android/.../generated/Tokens.kt
 *
 *   pnpm tokens:build            regenerate (writes only files that changed)
 *   pnpm tokens:build --check    exit 1 if a committed file is missing or out of date (CI)
 */
import { relative } from "node:path";
import { compareOutputs, generate, REPO_ROOT, TOKENS_PATH, writeOutputs } from "../src/fs";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: tokens:build [--check]`);
  process.exit(2);
}
const check = args.includes("--check");

let files: ReturnType<typeof generate>;
try {
  files = generate();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const source = relative(REPO_ROOT, TOKENS_PATH);

if (check) {
  const stale = compareOutputs(files).filter((file) => file.status !== "unchanged");
  if (stale.length > 0) {
    console.error(`Generated files are out of date with ${source}:`);
    for (const file of stale) console.error(`  ${file.status.padEnd(9)} ${file.path}`);
    console.error("Run `pnpm tokens:build` and commit the result.");
    process.exit(1);
  }
  console.log(`tokens: ${files.length} generated files match ${source}.`);
} else {
  const statuses = writeOutputs(files);
  for (const file of statuses) {
    console.log(`  ${file.status === "unchanged" ? "unchanged" : "wrote    "} ${file.path}`);
  }
  const written = statuses.filter((file) => file.status !== "unchanged").length;
  console.log(`tokens: ${written} of ${files.length} files updated from ${source}.`);
}
