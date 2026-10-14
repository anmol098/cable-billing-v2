// @vitest-environment node
/**
 * `/api/health` (T-005, T-096a): the database check (`select 1`, 2 s timeout) for up, down
 * (unreachable URL), hanging (a server that accepts and never answers) and not configured, and the
 * route's 200/503 with a body that carries statuses only.
 */
import { createServer, type Server, type Socket } from "node:net";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import {
  type CheckStatus,
  closeDatabasePings,
  DB_PING_TIMEOUT_MS,
  databasePing,
  getHealth,
  pingDatabase,
  withTimeout,
} from "./health";

const now = new Date("2026-10-13T06:00:00.000Z");
/** Nothing listens on port 1: the connection is refused at once. */
const UNREACHABLE_URL = "postgres://postgres:postgres@127.0.0.1:1/cable_billing";

afterAll(async () => {
  await closeDatabasePings();
});

describe("getHealth", () => {
  it("reports ok, the app version and a not-configured DB without a ping", async () => {
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

  it("is ok when the DB answers", async () => {
    expect(await getHealth({ now, pingDb: async () => "ok" })).toMatchObject({
      status: "ok",
      checks: { db: { status: "ok" } },
    });
  });

  it("is degraded when the DB ping fails or throws", async () => {
    expect((await getHealth({ now, pingDb: async () => "error" })).status).toBe("degraded");
    const throwing = await getHealth({
      now,
      pingDb: () => Promise.reject(new Error("connection refused")),
    });
    expect(throwing).toMatchObject({ status: "degraded", checks: { db: { status: "error" } } });
    expect(JSON.stringify(throwing)).not.toContain("refused");
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports error when the ping does not settle in time", async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<CheckStatus>(() => {}), DB_PING_TIMEOUT_MS);
    let settled: CheckStatus | undefined;
    void result.then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(DB_PING_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe("error");
  });

  it("passes a quick answer through, and turns a rejection into error", async () => {
    expect(await withTimeout(Promise.resolve("ok"), 1_000)).toBe("ok");
    expect(await withTimeout(Promise.reject(new Error("boom")), 1_000)).toBe("error");
  });
});

describe("pingDatabase", () => {
  it("runs select 1 in a read-only platform transaction", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const withPlatform = vi.fn(async (fn: (tx: never) => Promise<unknown>, options?: unknown) => {
      expect(options).toEqual({ accessMode: "read only" });
      return fn({ execute } as never);
    });
    expect(await pingDatabase({ withPlatform } as never)).toBe("ok");
    expect(execute).toHaveBeenCalledWith("select 1");
  });

  it("throws when the transaction fails (getHealth turns that into error)", async () => {
    const withPlatform = async () => {
      throw new Error("permission denied to set role");
    };
    await expect(pingDatabase({ withPlatform } as never)).rejects.toThrow();
  });
});

describe("databasePing", () => {
  it("is not_configured without a URL", async () => {
    expect(await databasePing(undefined)()).toBe("not_configured");
    expect(await databasePing("")()).toBe("not_configured");
  });

  it("is error for an unreachable database", async () => {
    const report = await getHealth({ now, pingDb: databasePing(UNREACHABLE_URL) });
    expect(report).toMatchObject({ status: "degraded", checks: { db: { status: "error" } } });
  });

  describe("a database that accepts connections but never answers", () => {
    let server: Server;
    const sockets = new Set<Socket>();
    let url: string;
    beforeAll(async () => {
      server = createServer((socket) => {
        sockets.add(socket); // read nothing, answer nothing
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      url = `postgres://postgres:postgres@127.0.0.1:${address.port}/cable_billing`;
    });
    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    it("times out to error, and concurrent requests share one ping", async () => {
      const ping = databasePing(url, { timeoutMs: 300 });
      const first = ping();
      const second = ping();
      expect(second).toBe(first);
      expect(await first).toBe("error");
      // The next request starts a fresh ping (it times out too: the server still never answers).
      const third = ping();
      expect(third).not.toBe(first);
      expect(await third).toBe("error");
    }, 10_000);
  });
});

describeDb("database health against Postgres", () => {
  const t = useTestDatabase();

  afterAll(async () => {
    await closeDatabasePings(); // before useTestDatabase drops the database
  });

  it("is ok as the owner (previews) and as a cb_app-shaped login role (production)", async () => {
    expect(await databasePing(t.current.url)()).toBe("ok");
    const { url } = await t.current.createLoginRole();
    expect(await databasePing(url)()).toBe("ok");
  });

  describe("GET /api/health", () => {
    let close: (() => Promise<void>) | undefined;
    async function loadRoute(databaseUrl: string) {
      vi.stubEnv("DATABASE_URL", databaseUrl);
      vi.resetModules();
      // The route's own module instance of the health check, so its pools can be closed.
      close = (await import("./health")).closeDatabasePings;
      return import("../app/api/health/route");
    }
    afterEach(async () => {
      await close?.();
      vi.unstubAllEnvs();
    });

    it("200 and db ok when the database is up", async () => {
      const { GET, dynamic, runtime } = await loadRoute(t.current.url);
      expect(runtime).toBe("nodejs");
      expect(dynamic).toBe("force-dynamic");
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ status: "ok", checks: { db: { status: "ok" } } });
    });

    it("503 and db error when the database is down, with statuses only in the body", async () => {
      const { GET } = await loadRoute(UNREACHABLE_URL);
      const response = await GET();
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: "degraded", checks: { db: { status: "error" } } });
      expect(Object.keys(body).sort()).toEqual(["checks", "commit", "status", "time", "version"]);
      const text = JSON.stringify(body);
      for (const internal of ["127.0.0.1", "postgres", "ECONNREFUSED", "cable_billing"]) {
        expect(text).not.toContain(internal);
      }
    });
  });
});
