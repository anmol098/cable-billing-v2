import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { getHealth } from "./health";

const now = new Date("2026-10-13T06:00:00.000Z");

describe("getHealth", () => {
  it("reports ok, the app version and a not-configured DB until T-020", async () => {
    expect(await getHealth({ now })).toEqual({
      status: "ok",
      version: packageJson.version,
      commit: null,
      time: "2026-10-13T06:00:00.000Z",
      checks: { db: { status: "not_configured" } },
    });
  });

  it("includes the deployed commit", async () => {
    expect((await getHealth({ now, commit: "abc123" })).commit).toBe("abc123");
  });

  it("is degraded when the DB ping fails or throws", async () => {
    expect((await getHealth({ now, pingDb: async () => "error" })).status).toBe("degraded");
    const throwing = await getHealth({
      now,
      pingDb: () => Promise.reject(new Error("connection refused")),
    });
    expect(throwing).toMatchObject({ status: "degraded", checks: { db: { status: "error" } } });
  });
});
