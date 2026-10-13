import { createDb } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { describe, expect, it } from "vitest";
import { captureLogs } from "../testing/fixtures";
import { logRuntimeRoleCheck, shouldCheckRuntimeRole, startRuntimeRoleCheck } from "./runtime-role";

describe("shouldCheckRuntimeRole", () => {
  it.each([
    [{ VERCEL_ENV: "production" }, true],
    [{ VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "staging" }, true],
    [{ VERCEL_ENV: "preview" }, false],
    [{ VERCEL_ENV: "development" }, false],
    [{}, false],
  ])("%o → %s", (env, expected) => {
    expect(shouldCheckRuntimeRole(env)).toBe(expected);
  });

  it("does not start outside production/staging", () => {
    const logs = captureLogs();
    expect(
      startRuntimeRoleCheck(
        { db: undefined as never, logger: logs.logger },
        { env: { VERCEL_ENV: "preview" } },
      ),
    ).toBe(false);
  });
});

describeDb("logRuntimeRoleCheck", () => {
  const t = useTestDatabase();

  it("logs the owner/superuser URL (shape A) as unsafe and calls the hook", async () => {
    const logs = captureLogs();
    const seen: string[][] = [];
    const report = await logRuntimeRoleCheck(
      { db: t.current.db, logger: logs.logger },
      { onUnsafe: (r) => seen.push(r.issues.map((i) => i.code)) },
    );
    expect(report?.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(logs.records).toEqual([
      expect.objectContaining({
        level: "error",
        event: "db.runtime_role_unsafe",
        issue_codes: expect.arrayContaining(["superuser"]),
      }),
    ]);
  });

  it("passes a non-owner login role (shape B) without an error", async () => {
    const { url } = await t.current.createLoginRole();
    const db = createDb({ connectionString: url, driver: "pg", max: 1, onIdleError: () => {} });
    try {
      const logs = captureLogs();
      const report = await logRuntimeRoleCheck({ db, logger: logs.logger });
      expect(report?.ok).toBe(true);
      expect(logs.records.map((r) => r.level)).not.toContain("error");
    } finally {
      await db.end();
    }
  });

  it("logs a failed check instead of throwing", async () => {
    const logs = captureLogs();
    const db = createDb({
      connectionString: "postgres://nobody:x@localhost:1/none",
      driver: "pg",
      max: 1,
      onIdleError: () => {},
    });
    try {
      expect(await logRuntimeRoleCheck({ db, logger: logs.logger })).toBeUndefined();
      expect(logs.records).toEqual([
        expect.objectContaining({ level: "error", event: "db.runtime_role_check_failed" }),
      ]);
    } finally {
      await db.end();
    }
  });
});
