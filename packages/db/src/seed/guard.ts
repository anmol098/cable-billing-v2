/**
 * Where the seed may write (T-036). Seed data is fake by design, so writing it next to real data
 * would be a disaster. Three independent guards:
 *
 * 1. **Never in production:** `VERCEL_ENV=production` (or `CB_SEED_FORBIDDEN=1`) refuses, with no
 *    override. Staging and previews hold seed data only (docs/runbooks/environments.md).
 * 2. **Local only by default:** a non-local host (Neon, any remote server) needs `--allow-remote`.
 * 3. **Empty databases only:** `seedDatabase` refuses a database that already has operators
 *    (checked in seed.ts), so even a mistaken production URL with `--allow-remote` is refused.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type SeedTargetCheck =
  | { readonly ok: true; readonly host: string; readonly local: boolean }
  | { readonly ok: false; readonly reason: string };

export function checkSeedTarget(input: {
  readonly url: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly allowRemote: boolean;
}): SeedTargetCheck {
  if (input.env.VERCEL_ENV === "production" || input.env.CB_SEED_FORBIDDEN === "1") {
    return {
      ok: false,
      reason:
        "Refusing to seed: this is a production environment (VERCEL_ENV=production or " +
        "CB_SEED_FORBIDDEN=1). Seed data is fake and must never be written next to real data.",
    };
  }
  if (!input.url) {
    return { ok: false, reason: "DATABASE_URL is not set: point it at the database to seed." };
  }
  let host: string;
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return { ok: false, reason: "DATABASE_URL must be a postgres:// URL." };
    }
    host = parsed.hostname;
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a valid postgres:// URL." };
  }
  const local = LOCAL_HOSTS.has(host);
  if (!local && !input.allowRemote) {
    return {
      ok: false,
      reason:
        `Refusing to seed the remote host "${host}". Seeding is for local, preview and staging ` +
        "databases: pass --allow-remote if this is one of them (never production).",
    };
  }
  return { ok: true, host, local };
}
