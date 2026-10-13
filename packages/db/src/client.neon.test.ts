/**
 * The runtime driver (`@neondatabase/serverless` Pool over WebSocket) against the local Postgres,
 * through a minimal WebSocket→TCP proxy (what Neon's proxy does in production). Proves the Neon
 * path gets the same role switch, tenant scoping, rollback and no leaks as node-postgres.
 */
import { type AddressInfo, connect } from "node:net";
import { neonConfig } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createDb, type DbClient } from "./client";
import { uuidv7 } from "./ids";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "./testing";
import { applyDemoSchema, demoNotes } from "./testing/demo-schema";

describeDb("createDb with the Neon serverless driver", () => {
  const t = useTestDatabase();
  let wss: WebSocketServer;
  let db: DbClient;
  let a: TestTenant;
  let b: TestTenant;
  let noteB: string;

  beforeAll(async () => {
    // ws → tcp: the Neon driver sends raw Postgres protocol bytes in binary frames.
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws, request) => {
      const address = new URL(request.url ?? "/", "http://proxy").searchParams.get("address") ?? "";
      const [host, port] = address.split(":");
      const tcp = connect(Number(port), host); // writes are buffered until connected
      ws.on("message", (data) => tcp.write(data as Buffer));
      tcp.on("data", (chunk) => ws.send(chunk));
      ws.on("close", () => tcp.destroy());
      tcp.on("close", () => ws.close());
      tcp.on("error", () => ws.close());
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const proxyPort = (wss.address() as AddressInfo).port;
    neonConfig.wsProxy = (host, port) => `127.0.0.1:${proxyPort}/v1?address=${host}:${port}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;

    await applyDemoSchema(t.current.admin);
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    noteB = uuidv7();
    await t.current.admin.query(
      "INSERT INTO demo_notes (id, operator_id, body) VALUES ($1, $2, 'a'), ($3, $4, 'b')",
      [uuidv7(), a.operatorId, noteB, b.operatorId],
    );
    db = createDb({ connectionString: t.current.url, driver: "neon", max: 1 });
  });

  afterAll(async () => {
    await db?.end();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  });

  it("scopes reads to the tenant and runs as app_rw", async () => {
    const result = await db.withTenant(a.operatorId, async (tx) => ({
      who: (await tx.execute<{ role: string }>(sql`select current_user as role`)).rows[0],
      rows: await tx.select().from(demoNotes),
      other: await tx.select().from(demoNotes).where(eq(demoNotes.id, noteB)),
    }));
    expect(db.driver).toBe("neon");
    expect(result.who).toEqual({ role: "app_rw" });
    expect(result.rows.map((r) => r.body)).toEqual(["a"]);
    expect(result.other).toEqual([]);
  });

  it("rolls back on error and doesn't leak the tenant into the next transaction (pool of 1)", async () => {
    const id = uuidv7();
    await expect(
      db.withTenant(a.operatorId, async (tx) => {
        await tx.insert(demoNotes).values({ id, operatorId: a.operatorId, body: "x" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(
      (await t.current.admin.query("SELECT 1 FROM demo_notes WHERE id = $1", [id])).rowCount,
    ).toBe(0);

    const platform = await db.withPlatform(async (tx) => ({
      who: (
        await tx.execute<{ role: string; op: string | null }>(
          sql`select current_user as role, app.current_operator()::text as op`,
        )
      ).rows[0],
      rows: await tx.select().from(demoNotes),
    }));
    expect(platform).toEqual({ who: { role: "app_platform", op: null }, rows: [] });
  });
});
