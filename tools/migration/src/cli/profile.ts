/**
 * `pnpm --filter @cb/migration legacy:profile [--allow-remote HOST] [--out-dir DIR] [--stdout]`
 *
 * Profiles the `legacy` schema of MIGRATION_TARGET_URL and writes the counts-only report to
 * docs/migration/profile-<IST date>.md. The report is checked for personal data first; if the
 * check finds anything, nothing is written and the exit code is 3.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeFindings } from "../pii/scan";
import { runProfile } from "../profile/run";
import { connectTarget, EXIT, REPO_DIR, runCli, userPath } from "./shared";

const USAGE = `Usage: pnpm --filter @cb/migration legacy:profile [options]

Writes the counts-only legacy profile to docs/migration/profile-<date>.md (date in IST).
  --allow-remote HOST  allow this exact non-local target host (see copy --help)
  --out-dir DIR        write into DIR instead of docs/migration
  --stdout             print the report instead of writing a file

Environment: MIGRATION_TARGET_URL (the database the copy step filled).
Exit codes: 0 written, 1 failed, 2 refused, 3 personal data found (nothing written).`;

runCli(async () => {
  const { values } = parseArgs({
    options: {
      "allow-remote": { type: "string" },
      "out-dir": { type: "string" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const client = await connectTarget(values["allow-remote"]);
  try {
    const run = await runProfile(client);
    if (run.findings.length > 0) {
      console.error(
        "The profile failed the personal-data check, so it was NOT written. Findings (values are " +
          `not repeated here):\n${describeFindings(run.findings)}`,
      );
      return EXIT.piiFound;
    }
    if (values.stdout) {
      process.stdout.write(run.markdown);
      return EXIT.ok;
    }
    const dir = values["out-dir"]
      ? userPath(values["out-dir"])
      : resolve(REPO_DIR, "docs", "migration");
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `profile-${run.profile.date}.md`);
    await writeFile(file, run.markdown);
    console.log(`wrote ${file} (${run.profile.tables.length} tables, personal-data check passed)`);
    return EXIT.ok;
  } finally {
    await client.end();
  }
});
