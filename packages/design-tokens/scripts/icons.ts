/**
 * icons.json + lucide-static → packages/ui/src/icons/icons.generated.ts (React)
 *                            + apps/android/core/designsystem/src/main/res/drawable/ic_cb_<name>.xml
 *
 *   pnpm icons:build            regenerate (writes only files that changed, deletes removed icons)
 *   pnpm icons:build --check    exit 1 if a committed file is missing, stale or left over (CI)
 */
import { relative } from "node:path";
import { REPO_ROOT } from "../src/fs";
import {
  compareIconOutputs,
  generateIcons,
  ICONS_PATH,
  type IconFileStatus,
  writeIconOutputs,
} from "../src/icons/fs";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: icons:build [--check]`);
  process.exit(2);
}
const check = args.includes("--check");

let files: ReturnType<typeof generateIcons>;
try {
  files = generateIcons();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const source = relative(REPO_ROOT, ICONS_PATH);
const label = (file: IconFileStatus) =>
  ({ unchanged: "unchanged", changed: "wrote    ", missing: "wrote    ", extra: "deleted  " })[
    file.status
  ];

if (check) {
  const stale = compareIconOutputs(files).filter((file) => file.status !== "unchanged");
  if (stale.length > 0) {
    console.error(`Generated icon files are out of date with ${source}:`);
    for (const file of stale) console.error(`  ${file.status.padEnd(9)} ${file.path}`);
    console.error("Run `pnpm icons:build` and commit the result.");
    process.exit(1);
  }
  console.log(`icons: ${files.length} generated files match ${source}.`);
} else {
  const statuses = writeIconOutputs(files);
  const touched = statuses.filter((file) => file.status !== "unchanged");
  for (const file of touched) console.log(`  ${label(file)} ${file.path}`);
  console.log(
    `icons: ${touched.length} of ${files.length} files updated from ${source}` +
      ` (${files.filter((file) => file.path.endsWith(".xml")).length} icons).`,
  );
}
