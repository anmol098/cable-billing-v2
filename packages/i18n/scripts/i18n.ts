/**
 * i18n CLI (run with tsx):
 *
 *   i18n.ts check                     validate the message sources (no files written)
 *   i18n.ts build                     validate, then write the generated web + Android files
 *   i18n.ts build --check             validate, then fail if any generated file is stale (CI drift)
 *
 * Add `--fail-on-review` to either command to also fail while `_review` flags remain (H-03 gate).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Issue, validateCatalog } from "../src/catalog";
import { generateFiles } from "../src/generate";
import { loadRawCatalog } from "../src/load";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "../..");
const messagesDir = join(packageDir, "messages");

const [command, ...flags] = process.argv.slice(2);
const known = new Set(["--check", "--fail-on-review"]);
const unknown = flags.filter((f) => !known.has(f));
if ((command !== "check" && command !== "build") || unknown.length > 0) {
  console.error("usage: i18n.ts check|build [--check] [--fail-on-review]");
  process.exit(2);
}
const driftOnly = flags.includes("--check");
const failOnReview = flags.includes("--fail-on-review");

function report(issues: Issue[]): void {
  for (const issue of issues) {
    const where = issue.key ? `${issue.file} › ${issue.key}` : issue.file;
    console.error(`  ✗ messages/${where}: ${issue.message}`);
  }
}

const loaded = loadRawCatalog(messagesDir);
const { catalog, errors, reviewCount } = validateCatalog(loaded.raw);
const allErrors = [...loaded.errors, ...errors];
if (allErrors.length > 0) {
  console.error(`i18n: ${allErrors.length} problem(s) in packages/i18n/messages:`);
  report(allErrors);
  process.exit(1);
}

const namespaces = Object.keys(catalog.en).length;
const keys = Object.values(catalog.en).reduce((n, ns) => n + ns.flat.size, 0);
console.log(`i18n: ${namespaces} namespace(s), ${keys} key(s) per locale, en + hi in sync.`);
if (reviewCount > 0) {
  const log = failOnReview ? console.error : console.log;
  log(`i18n: ${reviewCount} Hindi string(s) flagged in _review for the product owner (D-23).`);
  if (failOnReview) process.exit(1);
}

if (command === "check") process.exit(0);

const files = generateFiles(catalog);
if (driftOnly) {
  const stale = files.filter((f) => {
    const path = join(repoRoot, f.path);
    return !existsSync(path) || readFileSync(path, "utf8") !== f.content;
  });
  if (stale.length > 0) {
    console.error(
      "i18n: generated files are out of date. Run `pnpm --filter @cb/i18n i18n:build`:",
    );
    for (const f of stale) console.error(`  ✗ ${f.path}`);
    process.exit(1);
  }
  console.log(`i18n: ${files.length} generated file(s) are up to date.`);
  process.exit(0);
}

for (const f of files) {
  const path = join(repoRoot, f.path);
  mkdirSync(dirname(path), { recursive: true });
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== f.content;
  if (changed) writeFileSync(path, f.content);
  console.log(`  ${changed ? "wrote" : "unchanged"} ${f.path}`);
}
