import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertTargetDeclaredNonProd, checkTarget, describeTarget } from "../target";

/** tools/migration (the package root), wherever the CLI is started from. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The repository root. */
export const REPO_DIR = resolve(PACKAGE_DIR, "../..");

/**
 * A path the user typed, resolved against the directory they ran the command from (pnpm runs
 * package scripts inside tools/migration and passes the original directory as INIT_CWD).
 */
export function userPath(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/** Exit codes shared by the CLIs. */
export const EXIT = { ok: 0, failed: 1, refused: 2, piiFound: 3 } as const;

export class RefusedError extends Error {}

/** Connects to MIGRATION_TARGET_URL after every guard in target.ts passed. */
export async function connectTarget(allowRemoteHost: string | undefined): Promise<pg.Client> {
  const check = checkTarget({
    url: process.env.MIGRATION_TARGET_URL,
    env: process.env,
    allowRemoteHost,
  });
  if (!check.ok) throw new RefusedError(check.reason);
  const client = new pg.Client({ connectionString: check.url });
  await client.connect();
  try {
    await assertTargetDeclaredNonProd(client, check);
  } catch (error) {
    await client.end();
    throw new RefusedError(error instanceof Error ? error.message : String(error));
  }
  console.error(`target: ${describeTarget(check.url)}${check.local ? " (local)" : ""}`);
  return client;
}

/** Runs a CLI main function with the shared exit-code conventions. */
export function runCli(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof RefusedError) {
        console.error(error.message);
        process.exitCode = EXIT.refused;
        return;
      }
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = EXIT.failed;
    },
  );
}
