/**
 * `pnpm --filter @cb/migration legacy:check FILE… [--with-data] [--allow-remote HOST]`
 *
 * Runs the personal-data check on finished profile files (e.g. before committing one that was
 * edited by hand). Without --with-data only the shape checks run (phones, e-mails, hashes, long
 * digit runs); with it, the values of the copied legacy data are checked too.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { collectForbiddenValues } from "../pii/forbidden";
import { describeFindings, type ForbiddenValues, scanForPii } from "../pii/scan";
import { readCatalog } from "../profile/catalog";
import { connectTarget, EXIT, runCli, userPath } from "./shared";

const USAGE = `Usage: pnpm --filter @cb/migration legacy:check FILE... [--with-data] [--allow-remote HOST]

Exit codes: 0 clean, 1 failed, 2 refused, 3 personal data found.`;

runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "with-data": { type: "boolean", default: false },
      "allow-remote": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? EXIT.ok : EXIT.refused;
  }
  let forbidden: ForbiddenValues | undefined;
  if (values["with-data"]) {
    const client = await connectTarget(values["allow-remote"]);
    try {
      forbidden = await collectForbiddenValues(client, await readCatalog(client));
    } finally {
      await client.end();
    }
  }
  let dirty = false;
  for (const file of positionals) {
    const findings = scanForPii(await readFile(userPath(file), "utf8"), forbidden);
    if (findings.length === 0) {
      console.log(`${file}: clean${forbidden ? "" : " (shape checks only)"}`);
    } else {
      dirty = true;
      console.error(`${file}: personal data found\n${describeFindings(findings)}`);
    }
  }
  return dirty ? EXIT.piiFound : EXIT.ok;
});
