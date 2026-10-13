/**
 * `pnpm --filter @cb/migration legacy:fixture [--scale small|legacy] [--seed N] [--out FILE]`
 *
 * Writes the synthetic legacy dump (fake data, see src/fixture/generate.ts). Default output:
 * tools/migration/data/fixture-<scale>.sql (git-ignored).
 */

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toMysqlDump } from "../fixture/dump";
import { FIXTURE_SCALES, type FixtureScale, generateFixture } from "../fixture/generate";
import { EXIT, PACKAGE_DIR, runCli, userPath } from "./shared";

const USAGE = `Usage: pnpm --filter @cb/migration legacy:fixture [--scale small|legacy] [--seed N] [--out FILE]

Writes a synthetic legacy MariaDB dump with FAKE data (documented table names, invented columns).
  --scale  small (default: 3 operators, 150 customers) or legacy (PRD App. A counts, ~146k invoices)
  --seed   random seed (default 7)
  --out    output file (default tools/migration/data/fixture-<scale>.sql, git-ignored)`;

runCli(async () => {
  const { values } = parseArgs({
    options: {
      scale: { type: "string", default: "small" },
      seed: { type: "string", default: "7" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (!(values.scale in FIXTURE_SCALES)) {
    console.error(USAGE);
    return EXIT.refused;
  }
  const scale = values.scale as FixtureScale;
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) {
    console.error("--seed must be an integer");
    return EXIT.refused;
  }
  const out = values.out
    ? userPath(values.out)
    : resolve(PACKAGE_DIR, "data", `fixture-${scale}.sql`);
  await mkdir(dirname(out), { recursive: true });
  const fixture = generateFixture({ scale, seed });
  const stream = createWriteStream(out);
  for (const chunk of toMysqlDump(fixture.tables)) {
    if (!stream.write(chunk)) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  for (const table of fixture.tables) console.log(`${table.name}: ${table.rows.length} rows`);
  console.log(`wrote ${out}`);
  return EXIT.ok;
});
