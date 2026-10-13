import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSeedArgs, runSeedCli, SeedArgsError } from "./cli";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSeedArgs", () => {
  it("has safe defaults", () => {
    expect(parseSeedArgs([])).toEqual({
      scale: "small",
      seed: "1",
      asOf: undefined,
      months: undefined,
      migrate: false,
      allowRemote: false,
      ifEmpty: false,
      password: true,
      concurrency: undefined,
      verify: undefined,
      dryRun: false,
      help: false,
    });
  });

  it("reads every option, with spaces or =", () => {
    expect(
      parseSeedArgs([
        "--",
        "--scale",
        "legacy",
        "--seed=42",
        "--as-of",
        "2026-10-13",
        "--months=3",
        "--migrate",
        "--allow-remote",
        "--if-empty",
        "--no-password",
        "--concurrency",
        "2",
        "--verify=0",
        "--dry-run",
      ]),
    ).toEqual({
      scale: "legacy",
      seed: "42",
      asOf: "2026-10-13",
      months: 3,
      migrate: true,
      allowRemote: true,
      ifEmpty: true,
      password: false,
      concurrency: 2,
      verify: 0,
      dryRun: true,
      help: false,
    });
  });

  it("rejects bad input", () => {
    for (const argv of [
      ["--scale", "huge"],
      ["--scale"],
      ["--as-of", "2026-02-30"],
      ["--months", "0"],
      ["--concurrency", "1.5"],
      ["--verify", "-1"],
      ["--wipe"],
    ]) {
      expect(() => parseSeedArgs(argv), argv.join(" ")).toThrow(SeedArgsError);
    }
  });
});

describe("runSeedCli refusals (no database touched)", () => {
  it("exits 2 for production, a remote host or bad arguments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const local = "postgres://postgres:postgres@localhost:5432/cable_billing";
    expect(await runSeedCli([], { DATABASE_URL: local, VERCEL_ENV: "production" })).toBe(2);
    expect(await runSeedCli([], { DATABASE_URL: "postgres://u:p@db.example.com/x" })).toBe(2);
    expect(await runSeedCli([], {})).toBe(2);
    expect(await runSeedCli(["--scale", "nope"], { DATABASE_URL: local })).toBe(2);
  });

  it("prints help and dry-runs without a database", async () => {
    const log = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runSeedCli(["--help"], {})).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("--scale small|legacy|10x");
    log.mockClear();
    expect(await runSeedCli(["--dry-run", "--as-of", "2026-10-13", "--months", "2"], {})).toBe(0);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toContain("nothing written");
    expect(out).toMatch(/invoices\s+[\d,]+/);
  }, 60_000);
});
