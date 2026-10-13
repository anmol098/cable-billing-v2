import { describe, expect, it } from "vitest";
import { checkSeedTarget } from "./guard";

const LOCAL = "postgres://postgres:postgres@localhost:5432/cable_billing";
const NEON = "postgres://owner:pw@ep-cool-1234.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

describe("checkSeedTarget", () => {
  it("allows local databases", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const result = checkSeedTarget({
        url: `postgres://u:p@${host}:5432/db`,
        env: {},
        allowRemote: false,
      });
      expect(result).toMatchObject({ ok: true, local: true });
    }
  });

  it("refuses a remote host unless --allow-remote", () => {
    expect(checkSeedTarget({ url: NEON, env: {}, allowRemote: false })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--allow-remote"),
    });
    expect(checkSeedTarget({ url: NEON, env: {}, allowRemote: true })).toMatchObject({
      ok: true,
      local: false,
    });
  });

  it("refuses production with no override, even locally", () => {
    for (const env of [{ VERCEL_ENV: "production" }, { CB_SEED_FORBIDDEN: "1" }]) {
      for (const url of [LOCAL, NEON]) {
        expect(checkSeedTarget({ url, env, allowRemote: true })).toMatchObject({ ok: false });
      }
    }
    // Previews and staging hold seed data only.
    for (const VERCEL_ENV of ["preview", "staging", "development"]) {
      expect(checkSeedTarget({ url: NEON, env: { VERCEL_ENV }, allowRemote: true }).ok).toBe(true);
    }
  });

  it("refuses a missing or malformed URL", () => {
    expect(checkSeedTarget({ url: undefined, env: {}, allowRemote: true }).ok).toBe(false);
    expect(checkSeedTarget({ url: "not a url", env: {}, allowRemote: true }).ok).toBe(false);
    expect(checkSeedTarget({ url: "mysql://localhost/db", env: {}, allowRemote: true }).ok).toBe(
      false,
    );
  });
});
