/**
 * restore.sh: where a dump may live (always tested, with --dry-run) and a real restore into a
 * scratch MariaDB database (only when LEGACY_TEST_MARIADB_URL is set; CI has no MariaDB).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import { toMysqlDump } from "./fixture/dump";
import { generateFixture } from "./fixture/generate";
import { mariadbTestUrl } from "./testing/mariadb";

const PACKAGE_DIR = resolve(import.meta.dirname, "..");
const REPO_DIR = resolve(PACKAGE_DIR, "../..");
const SCRIPT = join(PACKAGE_DIR, "restore.sh");

function restore(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

function tempFile(dir: string, name: string, content = "SELECT 1;\n"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  cleanup.push(path);
  return path;
}

describe("restore.sh path rules", () => {
  const outside = mkdtempSync(join(tmpdir(), "cb-restore-"));
  cleanup.push(outside);
  const tag = randomBytes(4).toString("hex");

  it("accepts a dump outside the repository", () => {
    const result = restore(["--dry-run", tempFile(outside, "legacy.sql")]);
    expect(result.out).toContain("path checks passed");
    expect(result.code).toBe(0);
  });

  it("accepts a dump in the git-ignored tools/migration/data/", () => {
    const result = restore(["--dry-run", tempFile(join(PACKAGE_DIR, "data"), `t-${tag}.sql`)]);
    expect(result.out).toContain("path checks passed");
    expect(result.code).toBe(0);
  });

  it("refuses a dump anywhere else inside the repository", () => {
    for (const path of [
      tempFile(join(PACKAGE_DIR, "src"), `t-${tag}.sql`),
      tempFile(REPO_DIR, `t-${tag}.sql.gz`),
    ]) {
      const result = restore(["--dry-run", path]);
      expect(result.code, path).toBe(2);
      expect(result.out).toContain("inside the repository");
    }
  });

  it("refuses tracked files, missing files and unknown types", () => {
    expect(restore(["--dry-run", join(REPO_DIR, "tasks", "README.md")]).code).toBe(2);
    expect(restore(["--dry-run", join(outside, "missing.sql")]).code).toBe(2);
    expect(restore(["--dry-run", tempFile(outside, "legacy.csv")]).code).toBe(2);
    expect(restore(["--bogus"]).code).toBe(2);
    expect(restore([]).code).toBe(2);
  });

  it("refuses unsafe database names", () => {
    const result = restore(["--dry-run", tempFile(outside, "x.sql")], {
      LEGACY_DB_NAME: "legacy; DROP",
    });
    expect(result.code).toBe(2);
  });
});

const serverUrl = mariadbTestUrl();
const hasClient = spawnSync("bash", ["-c", "command -v mariadb"]).status === 0;

describe.skipIf(!serverUrl || !hasClient)("restore.sh into MariaDB (--local)", () => {
  it("restores the synthetic dump, gzipped, into a fresh database", async () => {
    const url = new URL(serverUrl ?? "");
    const name = `cb_mig_test_${randomBytes(6).toString("hex")}`;
    const dir = mkdtempSync(join(tmpdir(), "cb-restore-"));
    cleanup.push(dir);
    const plain = join(dir, "fixture.sql");
    const fixture = generateFixture({ scale: "small", seed: 5 });
    writeFileSync(plain, [...toMysqlDump(fixture.tables)].join(""));
    expect(spawnSync("gzip", [plain]).status).toBe(0);
    const env = {
      LEGACY_DB_HOST: url.hostname,
      LEGACY_DB_PORT: url.port || "3306",
      LEGACY_DB_USER: decodeURIComponent(url.username),
      LEGACY_DB_PASSWORD: decodeURIComponent(url.password),
      LEGACY_DB_NAME: name,
    };
    const conn = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: env.LEGACY_DB_USER,
      password: env.LEGACY_DB_PASSWORD,
    });
    try {
      const result = restore(["--local", `${plain}.gz`], env);
      expect(result.out).toContain(`restored: ${fixture.tables.length} tables`);
      expect(result.code).toBe(0);
      const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\`.invoice`);
      expect(Number((rows as { n: number }[])[0]?.n)).toBe(
        fixture.tables.find((t) => t.name === "invoice")?.rows.length,
      );
    } finally {
      await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await conn.end();
    }
  });
});
