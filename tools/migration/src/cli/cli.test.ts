/** The CLIs' guards and exit codes, run as a human would run them (no database is touched). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");
const TSX = join(PACKAGE_DIR, "node_modules", ".bin", "tsx");

function cli(script: string, args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync(TSX, [join(PACKAGE_DIR, "src", "cli", script), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 60_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const dir = mkdtempSync(join(tmpdir(), "cb-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("CLI guards", () => {
  it("copy refuses without MIGRATION_TARGET_URL, even when DATABASE_URL is set", () => {
    const result = cli("copy.ts", [], {
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/cable_billing",
    });
    expect(result.code).toBe(2);
    expect(result.out).toContain("MIGRATION_TARGET_URL is not set");
  });

  it("copy refuses a remote target that was not named with --allow-remote", () => {
    const result = cli("copy.ts", [], {
      MIGRATION_TARGET_URL: "postgres://u:secretpw@ep-x-123.ap-southeast-1.aws.neon.tech/neondb",
    });
    expect(result.code).toBe(2);
    expect(result.out).toContain("Refusing the remote host");
    expect(result.out).not.toContain("secretpw");
  });

  it("copy refuses a remote legacy source", () => {
    const result = cli("copy.ts", [], {
      MIGRATION_TARGET_URL: "postgres://postgres:postgres@localhost:5432/stage",
      LEGACY_DB_URL: "mysql://root:pw@legacy.example.com:3306/legacy",
    });
    expect(result.code).toBe(2);
    expect(result.out).toContain("remote legacy source");
  });

  it("profile refuses in production", () => {
    const result = cli("profile.ts", [], {
      MIGRATION_TARGET_URL: "postgres://postgres:postgres@localhost:5432/stage",
      VERCEL_ENV: "production",
    });
    expect(result.code).toBe(2);
  });

  it("check-profile exits 3 on personal data and 0 on a clean file", () => {
    const clean = join(dir, "clean.md");
    const dirty = join(dir, "dirty.md");
    writeFileSync(clean, "# Legacy data profile\n\n| `costumer` | 7,616 |\n");
    writeFileSync(dirty, "# Legacy data profile\n\n| leaked | 98765 43210 |\n");
    expect(cli("check-profile.ts", [clean], {}).code).toBe(0);
    const result = cli("check-profile.ts", [dirty], {});
    expect(result.code).toBe(3);
    expect(result.out).toContain("line 3: phone");
    expect(result.out).not.toContain("43210");
  });
});
