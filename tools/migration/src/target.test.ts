import type pg from "pg";
import { describe, expect, it } from "vitest";
import { assertTargetDeclaredNonProd, checkTarget } from "./target";

const LOCAL = "postgres://postgres:postgres@localhost:5432/cb_legacy_stage";
const NEON = "postgres://owner:pw@ep-cool-frost-123456.ap-southeast-1.aws.neon.tech/neondb";

describe("checkTarget", () => {
  it("accepts a local Postgres", () => {
    expect(checkTarget({ url: LOCAL, env: {} })).toMatchObject({ ok: true, local: true });
  });

  it("refuses production environments, with no override", () => {
    for (const env of [
      { VERCEL_ENV: "production" },
      { NODE_ENV: "production" },
      { CB_MIGRATION_FORBIDDEN: "1" },
    ]) {
      expect(checkTarget({ url: LOCAL, env, allowRemoteHost: "localhost" }).ok).toBe(false);
    }
  });

  it("requires MIGRATION_TARGET_URL and a postgres:// URL", () => {
    expect(checkTarget({ url: undefined, env: {} }).ok).toBe(false);
    expect(checkTarget({ url: "not a url", env: {} }).ok).toBe(false);
    expect(checkTarget({ url: "mysql://root@localhost/legacy", env: {} }).ok).toBe(false);
  });

  it("refuses host, database or user names that look like production", () => {
    for (const url of [
      "postgres://postgres:pw@localhost:5432/cable_billing_prod",
      "postgres://prod:pw@localhost:5432/stage",
      "postgres://postgres:pw@localhost/production",
      "postgres://u:pw@db-live.example.com/x",
    ]) {
      const result = checkTarget({ url, env: {}, allowRemoteHost: new URL(url).hostname });
      expect(result.ok, url).toBe(false);
    }
    // Words that merely contain the letters are fine.
    expect(checkTarget({ url: "postgres://u:p@localhost/products_test", env: {} }).ok).toBe(true);
  });

  it("refuses remote hosts unless that exact host is allowed", () => {
    expect(checkTarget({ url: NEON, env: {} }).ok).toBe(false);
    expect(checkTarget({ url: NEON, env: {}, allowRemoteHost: "ep-other.neon.tech" }).ok).toBe(
      false,
    );
    expect(
      checkTarget({
        url: NEON,
        env: {},
        allowRemoteHost: "ep-cool-frost-123456.ap-southeast-1.aws.neon.tech",
      }),
    ).toMatchObject({ ok: true, local: false });
  });

  it("never echoes the password in a refusal", () => {
    const result = checkTarget({ url: NEON, env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("pw");
  });
});

describe("assertTargetDeclaredNonProd", () => {
  const client = (value: string | null) =>
    ({ query: async () => ({ rows: [{ value }] }) }) as unknown as pg.ClientBase;
  const remote = { ok: true, url: NEON, host: "ep", local: false } as const;

  it("requires the marker on remote databases", async () => {
    await expect(assertTargetDeclaredNonProd(client(null), remote)).rejects.toThrow(/unset/);
    await expect(assertTargetDeclaredNonProd(client("prod"), remote)).rejects.toThrow(/Refusing/);
    await expect(assertTargetDeclaredNonProd(client("non-prod"), remote)).resolves.toBeUndefined();
  });

  it("does not need the marker locally", async () => {
    const local = { ok: true, url: LOCAL, host: "localhost", local: true } as const;
    await expect(assertTargetDeclaredNonProd(client(null), local)).resolves.toBeUndefined();
  });
});
