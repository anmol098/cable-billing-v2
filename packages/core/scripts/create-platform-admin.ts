/**
 * `pnpm --filter @cb/core admin:create` (T-086d): makes a platform admin and prints their one-time
 * setup link. Run by an existing admin or an operator of the platform, never from the web.
 *
 * ```text
 * pnpm --filter @cb/core admin:create -- --by you@example.com --email a@example.com --name "Asha Rao"
 *                                        [--login asha] [--language en|hi] [--base-url https://…]
 * pnpm --filter @cb/core admin:create -- --by you@example.com --reissue --email a@example.com
 * pnpm --filter @cb/core admin:create -- --bootstrap --email first@example.com --name "First Admin"
 * ```
 *
 * - **Who issues it** is recorded as the audit event's actor:
 *   - `--by <email>`: you, an active platform admin with 2-step sign-in on.
 *   - `--bootstrap`: only for the very first admin, while no platform admin has 2-step sign-in.
 *     The actor is then the system, and the OS user and host name this ran on are recorded.
 * - **New admin:** the account gets an unusable password. Whoever opens the link sets the password
 *   and turns on 2-step sign-in (TOTP) in one go. Nobody can sign in before that.
 * - **`--reissue`:** a new link for an admin who has not turned on 2-step sign-in yet (an admin
 *   made before T-086d, or whose link ran out). Their password is made unusable and their sessions
 *   are ended. Older links stop working. Refused for an admin who already has 2-step sign-in.
 *
 * The link works once, for 1 hour. Send it to the admin over a channel only they read: it is the
 * key to the account until it is used. Only its hash is stored. The token is in the link's
 * `#fragment`, so it never reaches the server's request logs. The link is printed, never logged.
 *
 * Database: `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`. Base URL: `--base-url`, else
 * `APP_BASE_URL`; it must be `https://`, except for localhost. Exit codes: 0 done, 1 failed,
 * 2 refused or bad arguments.
 */
import { hostname, userInfo } from "node:os";
import { createDb } from "@cb/db";
import {
  ADMIN_SETUP_LINK_TTL_SECONDS,
  AdminSetupIssueError,
  type AdminSetupIssuer,
  adminSetupBaseUrlProblem,
  adminSetupUrl,
  createPlatformAdmin,
  reissueAdminSetupLink,
} from "../src/auth/admin-setup";

const USAGE = `Usage:
  pnpm --filter @cb/core admin:create -- (--by YOUR_EMAIL | --bootstrap) --email EMAIL --name NAME
                                         [--login LOGIN] [--language en|hi] [--base-url URL]
  pnpm --filter @cb/core admin:create -- (--by YOUR_EMAIL | --bootstrap) --reissue --email EMAIL [--base-url URL]`;

const FLAGS = new Set(["--reissue", "--bootstrap"]);
const OPTIONS = ["email", "name", "login", "language", "base-url", "by"];

interface Args {
  readonly email: string;
  readonly name: string | undefined;
  readonly login: string | undefined;
  readonly language: "en" | "hi";
  readonly baseUrl: string | undefined;
  readonly reissue: boolean;
  readonly by: string | undefined;
  readonly bootstrap: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg && FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (!arg?.startsWith("--") || i + 1 >= argv.length) return null;
    values.set(arg.slice(2), argv[i + 1] ?? "");
    i += 1;
  }
  for (const key of values.keys()) if (!OPTIONS.includes(key)) return null;
  const email = values.get("email");
  const language = values.get("language") ?? "en";
  const reissue = flags.has("--reissue");
  const bootstrap = flags.has("--bootstrap");
  const by = values.get("by");
  if (!email || (language !== "en" && language !== "hi")) return null;
  if (!reissue && !values.get("name")) return null;
  // Exactly one of --by and --bootstrap.
  if (Boolean(by) === bootstrap) return null;
  return {
    email,
    name: values.get("name"),
    login: values.get("login"),
    language,
    baseUrl: values.get("base-url") ?? process.env.APP_BASE_URL,
    reissue,
    by,
    bootstrap,
  };
}

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "unknown";
  }
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
  const baseUrlProblem = adminSetupBaseUrlProblem(args.baseUrl);
  if (!args.baseUrl || baseUrlProblem) {
    console.error(
      `Set --base-url or APP_BASE_URL to the web app's origin, e.g. https://app.example.com (${baseUrlProblem ?? "missing"}).`,
    );
    return 2;
  }
  const by: AdminSetupIssuer = args.by
    ? { kind: "admin", email: args.by }
    : { kind: "bootstrap", osUser: osUser(), host: hostname() };
  const db = createDb({ connectionString, max: 1 });
  try {
    const issued = args.reissue
      ? await reissueAdminSetupLink({ db }, { email: args.email, by })
      : await createPlatformAdmin(
          { db },
          {
            email: args.email,
            name: args.name ?? "",
            login: args.login ?? args.email.split("@")[0] ?? "",
            language: args.language,
            by,
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
