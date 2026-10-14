/**
 * `pnpm --filter @cb/core admin:create` (T-086d): makes a platform admin and prints their one-time
 * setup link. Run by an existing admin or an operator of the platform, never from the web.
 *
 * ```text
 * pnpm --filter @cb/core admin:create -- --email a@example.com --name "Asha Rao" [--login asha]
 *                                        [--language en|hi] [--base-url https://app.example.com]
 * pnpm --filter @cb/core admin:create -- --reissue --email a@example.com [--base-url …]
 * ```
 *
 * - New admin: the account has **no password**. Whoever opens the link sets the password and turns
 *   on 2-step sign-in (TOTP) in one go; nobody can sign in before that.
 * - `--reissue`: a new link for an admin who has not turned on 2-step sign-in yet (an admin made
 *   before T-086d, or whose link ran out). Their password and sessions are removed; older links
 *   stop working. Refused for an admin who already has 2-step sign-in.
 *
 * The link works once, for 1 hour. Send it to the admin over a channel only they read; it is the
 * key to the account until it is used. Only its hash is stored. The link is printed, never logged.
 *
 * Database: `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`. Base URL: `--base-url`, else
 * `APP_BASE_URL`. Exit codes: 0 done, 1 failed, 2 refused or bad arguments.
 */
import { createDb } from "@cb/db";
import {
  ADMIN_SETUP_LINK_TTL_SECONDS,
  AdminSetupIssueError,
  adminSetupUrl,
  createPlatformAdmin,
  reissueAdminSetupLink,
} from "../src/auth/admin-setup";

const USAGE = `Usage:
  pnpm --filter @cb/core admin:create -- --email EMAIL --name NAME [--login LOGIN] [--language en|hi] [--base-url URL]
  pnpm --filter @cb/core admin:create -- --reissue --email EMAIL [--base-url URL]`;

interface Args {
  readonly email: string;
  readonly name: string | undefined;
  readonly login: string | undefined;
  readonly language: "en" | "hi";
  readonly baseUrl: string | undefined;
  readonly reissue: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  const values = new Map<string, string>();
  let reissue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--reissue") {
      reissue = true;
      continue;
    }
    if (!arg?.startsWith("--") || i + 1 >= argv.length) return null;
    values.set(arg.slice(2), argv[i + 1] ?? "");
    i += 1;
  }
  for (const key of values.keys()) {
    if (!["email", "name", "login", "language", "base-url"].includes(key)) return null;
  }
  const email = values.get("email");
  const language = values.get("language") ?? "en";
  if (!email || (language !== "en" && language !== "hi")) return null;
  if (!reissue && !values.get("name")) return null;
  return {
    email,
    name: values.get("name"),
    login: values.get("login"),
    language,
    baseUrl: values.get("base-url") ?? process.env.APP_BASE_URL,
    reissue,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED).");
    return 2;
  }
  if (!args.baseUrl || !/^https?:\/\/[^/]+\/?$/.test(args.baseUrl)) {
    console.error(
      "Set --base-url or APP_BASE_URL to the web app's origin, e.g. https://app.example.com",
    );
    return 2;
  }
  const db = createDb({ connectionString, max: 1 });
  try {
    const issued = args.reissue
      ? await reissueAdminSetupLink({ db }, { email: args.email })
      : await createPlatformAdmin(
          { db },
          {
            email: args.email,
            name: args.name ?? "",
            login: args.login ?? args.email.split("@")[0] ?? "",
            language: args.language,
          },
        );
    const minutes = Math.round(ADMIN_SETUP_LINK_TTL_SECONDS / 60);
    console.log(args.reissue ? "New setup link made." : "Platform admin made (no password yet).");
    console.log(`User id: ${issued.userId}`);
    console.log(
      `Setup link (works once, for ${minutes} minutes, until ${issued.expiresAt.toISOString()}):`,
    );
    console.log(adminSetupUrl(args.baseUrl, issued.token));
    return 0;
  } catch (error) {
    if (error instanceof AdminSetupIssueError) {
      console.error(`Refused: ${error.code}`);
      return 2;
    }
    console.error("Failed:", error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await db.end();
  }
}

process.exitCode = await main();
