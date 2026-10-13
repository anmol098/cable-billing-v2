/**
 * Zod schemas (+ fixtures as examples) → packages/contracts/openapi.json.
 *
 *   pnpm --filter @cb/contracts openapi:build            write openapi.json
 *   pnpm --filter @cb/contracts openapi:build --check    exit 1 if openapi.json is missing or stale (CI)
 *
 * Also runs as the package's `generate` script, so `pnpm generate` keeps it current.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureExamples, loadFixtures } from "../src/fixtures";
import { buildOpenApiDocument, openApiJson } from "../src/openapi";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: openapi:build [--check]`);
  process.exit(2);
}
const check = args.includes("--check");

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(packageDir, "openapi.json");
const shown = relative(process.cwd(), target) || target;

const text = openApiJson(buildOpenApiDocument(fixtureExamples(loadFixtures())));

if (check) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (current !== text) {
    console.error(
      `${shown} is ${current === undefined ? "missing" : "out of date"}. Run: pnpm --filter @cb/contracts openapi:build`,
    );
    process.exit(1);
  }
  console.log(`${shown} is up to date.`);
} else {
  writeFileSync(target, text);
  console.log(`Wrote ${shown}.`);
}
