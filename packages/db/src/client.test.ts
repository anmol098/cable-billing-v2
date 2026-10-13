import { describe, expect, it } from "vitest";
import { createDb, resolveDriver } from "./client";

describe("resolveDriver", () => {
  it("uses Neon's WebSocket driver for Neon hosts and node-postgres otherwise", () => {
    expect(resolveDriver("postgres://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb")).toBe(
      "neon",
    );
    expect(resolveDriver("postgres://u:p@localhost:5432/cable_billing")).toBe("pg");
    expect(resolveDriver("postgres://u:p@neon.tech.evil.example/db")).toBe("pg");
  });

  it("honours an explicit driver", () => {
    expect(resolveDriver("postgres://u:p@localhost/db", "neon")).toBe("neon");
    expect(resolveDriver("postgres://u:p@x.neon.tech/db", "pg")).toBe("pg");
  });

  it("rejects a malformed URL without echoing it", () => {
    expect(() => resolveDriver("not a url with secret")).toThrow(
      "createDb: connectionString is not a valid URL",
    );
  });
});

describe("createDb", () => {
  it("connects lazily and exposes only the transaction wrappers", async () => {
    const db = createDb({ connectionString: "postgres://u:p@localhost:1/none" });
    expect(db.driver).toBe("pg");
    expect(Object.keys(db).sort()).toEqual(["driver", "end", "withPlatform", "withTenant"]);
    await db.end();
  });
});
