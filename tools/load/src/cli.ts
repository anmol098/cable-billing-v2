/**
 * `pnpm load <run|warm|plan|check>`: the load-test command (T-095). Runbook:
 * docs/testing/performance.md. Exit codes: 0 ok, 1 budget failed (with --gate), 2 bad options or
 * refused, 3 target not ready.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliOptions, HELP, parseCli } from "./args";
import { SessionCache } from "./auth";
import { setExtraHeaders } from "./http";
import { seedPersonas } from "./personas";
import { type RunResult, recheck, renderMarkdown, writeResult } from "./report";
import { runLoad, TargetNotReadyError, uncachedLogins, warmSessions } from "./run";
import { orderScenarios, plannedLogins, SCENARIOS } from "./scenarios";

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function log(line: string): void {
  console.log(line);
}

function plan(options: CliOptions): number {
  const personas = seedPersonas(options.seedScale, options.seed);
  const scenarios = orderScenarios(options.scenarios);
  const profile = options.profile;
  const logins = plannedLogins(scenarios, { personas, profile });
  log(`profile ${profile.name} on seed ${options.seedScale}: ${personas.length} operators`);
  for (const name of scenarios) {
    const users = SCENARIOS[name].logins({ personas, profile }).length;
    log(
      `  ${name.padEnd(9)} ${String(users).padStart(4)} users · ${SCENARIOS[name].description}${SCENARIOS[name].writes ? " (writes)" : ""}`,
    );
  }
  log(`  sign-ins: ${logins.length} distinct users`);
  if (options.baseUrl && options.cachePath) {
    const missing = uncachedLogins(new SessionCache(options.cachePath), options.baseUrl, logins);
    log(
      `  not cached for ${options.baseUrl}: ${missing.length} (this call may make ${options.maxSignIns})`,
    );
  }
  log(
    `  shape: ${profile.linemen} phones × (${profile.syncRounds} sync rounds, ${profile.paymentBatches}×${profile.paymentsPerBatch} payments + 1 replay); ` +
      `${profile.counterUsers} clerks × ${profile.counterPayments} payments; ${profile.webUsers} office users × ${profile.webRounds} rounds; ` +
      `${profile.exportOwners} owners × ${profile.exportsPerOwner} files`,
  );
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv, process.env, new Date(), TOOL_DIR);
  } catch (error) {
    console.error(`load: ${error instanceof Error ? error.message : error}\n`);
    console.error(HELP);
    return 2;
  }
  if (options.help) {
    log(HELP);
    return 0;
  }
  if (options.command === "plan") return plan(options);
  if (options.command === "check") {
    const result = recheck(JSON.parse(readFileSync(options.file ?? "", "utf8")) as RunResult);
    process.stdout.write(renderMarkdown(result));
    return options.gate && !result.pass ? 1 : 0;
  }
  const input = {
    baseUrl: options.baseUrl ?? "",
    profile: options.profile,
    seedScale: options.seedScale,
    seed: options.seed,
    scenarios: options.scenarios,
    password: options.password,
    cronSecret: options.cronSecret,
    appVersionCode: options.appVersionCode,
    billingWorkers: options.billingWorkers,
    maxSignIns: options.maxSignIns,
    cachePath: options.cachePath,
    label: options.label,
    log,
  };
  setExtraHeaders(options.extraHeaders);
  try {
    if (options.command === "warm") {
      const warm = await warmSessions(input);
      log(
        `warm: ${warm.planned} users planned, ${warm.signedIn} signed in now, ${warm.failed} failed, ${warm.missing} still missing`,
      );
      if (warm.missing > 0)
        log("Run warm again in 15 minutes (the sign-in limit is per 15 minutes).");
      return warm.failed > 0 ? 2 : 0;
    }
    const result = await runLoad(input);
    const files = writeResult(options.out, result);
    process.stdout.write(`\n${renderMarkdown(result)}`);
    log(`\nwrote ${files.json}\n      ${files.markdown}`);
    return options.gate && !result.pass ? 1 : 0;
  } catch (error) {
    // Refused (sign-in budget, missing secret) or broken: nothing was measured.
    console.error(`load: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof TargetNotReadyError ? 3 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}

export { main };
