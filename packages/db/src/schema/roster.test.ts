/**
 * Roster change tracking (T-060): the triggers of migration 0013 keep `roster_versions` in step
 * with every change a lineman's roster row shows (customer, balance, connections, area name, VC
 * number), in the writer's transaction, with a strictly increasing `changed_at`; RLS keeps each
 * tenant to its own rows.
 */
import { sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { sqlStateOf } from "../triggers";
import { rosterVersions } from "./roster";

interface Version {
  xid: string;
  at: string;
}

describeDb("roster_versions", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  const q = (text: string, params: unknown[] = []) => t.current.admin.query(text, params);

  async function version(customerId: string): Promise<Version | undefined> {
    const { rows } = await q(
      `SELECT change_xid::text AS xid, to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM roster_versions WHERE customer_id = $1`,
      [customerId],
    );
    return rows[0] as Version | undefined;
  }

  async function addCustomer(
    tenant: TestTenant,
    updatedAt = "2026-10-13T05:00:00.123456Z",
    areaId: string | null = null,
  ): Promise<string> {
    const id = uuidv7();
    await q(
      `INSERT INTO customers (id, operator_id, customer_code, name, area_id, updated_at)
       VALUES ($1, $2, $3, 'Ramesh Kumar', $4, $5)`,
      [id, tenant.operatorId, `R${id.slice(-8)}`, areaId, updatedAt],
    );
    return id;
  }

  it("records a new customer with its transaction and updated_at (ms precision)", async () => {
    const client = await t.current.admin.connect();
    try {
      await client.query("BEGIN");
      const xid = (await client.query("SELECT pg_current_xact_id()::text AS x")).rows[0].x;
      const id = uuidv7();
      await client.query(
        `INSERT INTO customers (id, operator_id, customer_code, name, updated_at)
         VALUES ($1, $2, $3, 'Sunita', '2026-10-13T05:00:00.123456Z')`,
        [id, a.operatorId, `S${id.slice(-8)}`],
      );
      await client.query("COMMIT");
      expect(await version(id)).toEqual({ xid, at: "2026-10-13T05:00:00.123Z" });
    } finally {
      client.release();
    }
  });

  it("moves forward on every change, never back, even when the writer's clock is older", async () => {
    const id = await addCustomer(a);
    const first = await version(id);
    await q("UPDATE customers SET name = 'Ramesh K', updated_at = $2 WHERE id = $1", [
      id,
      "2026-10-13T06:00:00.000Z",
    ]);
    const second = await version(id);
    expect(BigInt(second?.xid ?? 0)).toBeGreaterThan(BigInt(first?.xid ?? 0));
    expect(second?.at).toBe("2026-10-13T06:00:00.000Z");

    // A transaction whose clock is behind (committed after a later one): +1 ms, never backwards.
    await q("UPDATE customers SET name = 'Ramesh', updated_at = $2 WHERE id = $1", [
      id,
      "2026-10-13T05:30:00.000Z",
    ]);
    expect((await version(id))?.at).toBe("2026-10-13T06:00:00.001Z");

    // An UPDATE that changes nothing touches nothing.
    const before = await version(id);
    await q("UPDATE customers SET name = name WHERE id = $1", [id]);
    expect(await version(id)).toEqual(before);
  });

  it("counts several changes in one transaction once", async () => {
    const id = await addCustomer(a);
    const client = await t.current.admin.connect();
    try {
      await client.query("BEGIN");
      for (const name of ["One", "Two", "Three"]) {
        await client.query("UPDATE customers SET name = $2, updated_at = $3 WHERE id = $1", [
          id,
          name,
          "2026-10-13T07:00:00.000Z",
        ]);
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await version(id))?.at).toBe("2026-10-13T07:00:00.000Z");
  });

  it("follows the balance read model, but not an empty balance row", async () => {
    const id = await addCustomer(a);
    const start = await version(id);
    await q("INSERT INTO customer_balances (customer_id, operator_id) VALUES ($1, $2)", [
      id,
      a.operatorId,
    ]);
    expect(await version(id)).toEqual(start);

    await q(
      `UPDATE customer_balances SET balance_paise = 45000, oldest_due_period = '2026-10-01',
         updated_at = '2026-10-13T08:00:00Z' WHERE customer_id = $1`,
      [id],
    );
    const billed = await version(id);
    expect(BigInt(billed?.xid ?? 0)).toBeGreaterThan(BigInt(start?.xid ?? 0));
    expect(billed?.at).toBe("2026-10-13T08:00:00.000Z");

    const other = await addCustomer(a);
    const created = await version(other);
    await q(
      `INSERT INTO customer_balances (customer_id, operator_id, credit_paise, balance_paise, updated_at)
       VALUES ($1, $2, 5000, -5000, '2026-10-13T09:00:00Z')`,
      [other, a.operatorId],
    );
    expect(BigInt((await version(other))?.xid ?? 0)).toBeGreaterThan(BigInt(created?.xid ?? 0));
  });

  it("follows connections, VC number corrections and area renames", async () => {
    const areaId = uuidv7();
    const otherArea = uuidv7();
    await q(
      `INSERT INTO areas (id, operator_id, name) VALUES ($1, $3, 'Shiv Nagar'), ($2, $3, 'Ram Nagar')`,
      [areaId, otherArea, a.operatorId],
    );
    const inArea = await addCustomer(a, undefined, areaId);
    const elsewhere = await addCustomer(a, undefined, otherArea);

    const vcId = uuidv7();
    const assignmentId = uuidv7();
    await q("INSERT INTO vc_assets (id, operator_id, vc_number) VALUES ($1, $2, '000123456789')", [
      vcId,
      a.operatorId,
    ]);
    let before = await version(inArea);
    await q(
      `INSERT INTO vc_assignments (id, operator_id, vc_asset_id, customer_id, start_date, rental_amount_paise, updated_at)
       VALUES ($1, $2, $3, $4, '2026-10-01', 30000, '2026-10-13T10:00:00Z')`,
      [assignmentId, a.operatorId, vcId, inArea],
    );
    let after = await version(inArea);
    expect(BigInt(after?.xid ?? 0)).toBeGreaterThan(BigInt(before?.xid ?? 0));
    expect(after?.at).toBe("2026-10-13T10:00:00.000Z");

    before = after;
    await q(
      "UPDATE vc_assignments SET status = 'suspended', updated_at = '2026-10-13T11:00:00Z' WHERE id = $1",
      [assignmentId],
    );
    after = await version(inArea);
    expect(after?.at).toBe("2026-10-13T11:00:00.000Z");

    before = after;
    await q(
      "UPDATE vc_assets SET vc_number = '000123456780', updated_at = '2026-10-13T12:00:00Z' WHERE id = $1",
      [vcId],
    );
    expect((await version(inArea))?.at).toBe("2026-10-13T12:00:00.000Z");

    const untouched = await version(elsewhere);
    await q("UPDATE areas SET archived_at = now() WHERE id = $1", [areaId]);
    expect((await version(inArea))?.at).toBe("2026-10-13T12:00:00.000Z");
    await q(
      "UPDATE areas SET name = 'Shiv Nagar East', updated_at = '2026-10-13T13:00:00Z' WHERE id = $1",
      [areaId],
    );
    expect((await version(inArea))?.at).toBe("2026-10-13T13:00:00.000Z");
    expect(await version(elsewhere)).toEqual(untouched);
  });

  it("is tenant-scoped: a tenant sees and touches only its own rows", async () => {
    const mine = await addCustomer(a);
    const theirs = await addCustomer(b);
    const seen = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select({ id: rosterVersions.customerId }).from(rosterVersions),
    );
    const ids = seen.map((r) => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);

    // A change made under withTenant (as app_rw) writes the roster row through RLS.
    const before = await version(mine);
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.execute(
        sql`UPDATE customers SET phone = '9876543210', updated_at = '2026-10-14T05:00:00Z' WHERE id = ${mine}`,
      ),
    );
    expect(BigInt((await version(mine))?.xid ?? 0)).toBeGreaterThan(BigInt(before?.xid ?? 0));

    // Writing another tenant's roster row directly is refused by RLS.
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.execute(sql`SELECT app.roster_touch(${b.operatorId}::uuid, ${theirs}::uuid, now())`),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === "42501");
    const raw = await q("SELECT operator_id FROM roster_versions WHERE customer_id = $1", [theirs]);
    expect(raw.rows[0]?.operator_id).toBe(b.operatorId);
  });
});
