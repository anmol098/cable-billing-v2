/**
 * Customers (T-022): PRD §15 #2 (customer code unique per tenant only), code normalisation (the
 * generated column agrees with normalizeCustomerCode), search indexes, RLS, composite FKs, the
 * append-only contact history (FR-004) and the no-delete / identity triggers.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { customerContactChanges, customers, normalizeCustomerCode } from "./customers";
import { areas } from "./tenancy";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";
const GENERATED_ALWAYS = "428C9";

const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;
const constraintOf = (e: unknown): string | undefined => {
  let current: unknown = e;
  for (let i = 0; i < 5 && current && typeof current === "object"; i += 1) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** Inputs whose normalisation the TS function and the generated column must agree on. */
const CODE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["A101", "A101"],
  ["a101", "A101"],
  ["  a101  ", "A101"],
  ["a  101", "A 101"],
  ["\ta\t\n101\r\n", "A 101"],
  ["0101", "0101"],
  ["101", "101"],
  ["ab-12/c", "AB-12/C"],
  ["ग्राहक 12", "ग्राहक 12"],
  ["éa", "éA"], // ASCII-only upper-casing: é stays as typed
  ["x y", "X Y"], // a no-break space is not ASCII whitespace
];

describe("normalizeCustomerCode", () => {
  it.each(CODE_CASES)("%j → %j", (input, expected) => {
    expect(normalizeCustomerCode(input)).toBe(expected);
  });
});

describeDb("customers", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  const customer = (
    tenant: TestTenant,
    overrides: Partial<typeof customers.$inferInsert> = {},
  ) => ({
    id: uuidv7(),
    operatorId: tenant.operatorId,
    customerCode: `C${uuidv7().slice(-6)}`,
    name: "Ramesh Kumar",
    ...overrides,
  });
  const insertCustomer = (
    tenant: TestTenant,
    overrides: Partial<typeof customers.$inferInsert> = {},
  ) => {
    const row = customer(tenant, overrides);
    return t.current.db
      .withTenant(tenant.operatorId, (tx) => tx.insert(customers).values(row).returning())
      .then(([inserted]) => {
        if (!inserted) throw new Error("insert returned nothing");
        return inserted;
      });
  };

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  it("the generated customer_code_norm equals normalizeCustomerCode for every case", async () => {
    for (const [input, expected] of CODE_CASES) {
      // One tenant per case: several inputs normalise to the same code.
      const row = await insertCustomer(await createTenant(t.current), { customerCode: input });
      expect(row.customerCodeNorm).toBe(expected);
      expect(row.customerCodeNorm).toBe(normalizeCustomerCode(input));
    }
  });

  it("PRD §15 #2: the same code is allowed in two operators and rejected within one, after normalisation", async () => {
    await insertCustomer(a, { customerCode: "1045" });
    await insertCustomer(b, { customerCode: "1045" });
    await insertCustomer(a, { customerCode: "K-7" });
    for (const duplicate of ["1045", " 1045 ", "k-7", " K-7\t"]) {
      const error = await insertCustomer(a, { customerCode: duplicate }).catch((e: unknown) => e);
      expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
      expect(constraintOf(error)).toBe("customers_operator_code_unique");
    }
    // Changing a code onto an existing one is rejected too.
    const other = await insertCustomer(a, { customerCode: "2000" });
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.update(customers).set({ customerCode: "k-7" }).where(eq(customers.id, other.id)),
      ),
    ).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
    const counts = await t.current.admin.query<{ operator_id: string; n: number }>(
      "SELECT operator_id, count(*)::int AS n FROM customers WHERE customer_code_norm = '1045' AND operator_id = ANY ($1) GROUP BY 1",
      [[a.operatorId, b.operatorId]],
    );
    expect(counts.rows).toHaveLength(2);
    expect(counts.rows.every((r) => r.n === 1)).toBe(true);
  });

  it("customer_code_norm can't be written directly", async () => {
    await expect(
      t.current.admin.query(
        "INSERT INTO customers (id, operator_id, customer_code, customer_code_norm, name) VALUES ($1, $2, 'x', 'Y', 'n')",
        [uuidv7(), a.operatorId],
      ),
    ).rejects.toSatisfy(failsWith(GENERATED_ALWAYS));
  });

  it("rejects blank or over-long codes, blank names, malformed phones and non-object KYC", async () => {
    for (const overrides of [
      { customerCode: "   " },
      { customerCode: "x".repeat(65) },
      { name: "  " },
      { phone: "98765 43210" },
      { phone: "12345" },
      { altPhone: "+91-9876543210" },
      { kyc: [] as unknown as Record<string, unknown> },
    ]) {
      await expect(insertCustomer(a, overrides)).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    }
    const ok = await insertCustomer(a, {
      customerCode: "x".repeat(64),
      phone: "+919876543210",
      altPhone: "9876543210",
      kyc: { id_type: "voter_id" },
    });
    expect(ok).toMatchObject({ status: "active", phone: "+919876543210" });
  });

  it("is tenant-scoped: another tenant can't see, change or create rows for it", async () => {
    const mine = await insertCustomer(a);
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(customers).where(eq(customers.id, mine.id)),
    );
    expect(seenByB).toEqual([]);
    const updatedByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.update(customers).set({ name: "hacked" }).where(eq(customers.id, mine.id)).returning(),
    );
    expect(updatedByB).toEqual([]);
    await expect(insertCustomer(b, { operatorId: a.operatorId })).rejects.toSatisfy(
      failsWith(RLS_VIOLATION),
    );
    // T-086: the platform role may read only operator_id and status (column grant), never a
    // customer's details: SELECT * is refused (42501, insufficient privilege).
    await expect(t.current.db.withPlatform((tx) => tx.select().from(customers))).rejects.toSatisfy(
      failsWith(RLS_VIOLATION),
    );
  });

  it("composite FK: a customer can't point at another tenant's area", async () => {
    const areaB = { id: uuidv7(), operatorId: b.operatorId, name: "B Bazaar" };
    await t.current.db.withTenant(b.operatorId, (tx) => tx.insert(areas).values(areaB));
    await expect(insertCustomer(a, { areaId: areaB.id })).rejects.toSatisfy(
      failsWith(FK_VIOLATION),
    );
    const areaA = { id: uuidv7(), operatorId: a.operatorId, name: "A Bazaar" };
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(areas).values(areaA));
    await expect(insertCustomer(a, { areaId: areaA.id })).resolves.toMatchObject({
      areaId: areaA.id,
    });
  });

  it("legacy ids are unique per operator (idempotent import) and come in pairs", async () => {
    await insertCustomer(a, { legacySource: "legacy:costumer", legacyId: "77" });
    await insertCustomer(b, { legacySource: "legacy:costumer", legacyId: "77" });
    await expect(
      insertCustomer(a, { legacySource: "legacy:costumer", legacyId: "77" }),
    ).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
    await expect(insertCustomer(a, { legacyId: "78" })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
  });

  it("customers are never deleted and keep their id and tenant; other fields can change", async () => {
    const row = await insertCustomer(a);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.delete(customers).where(eq(customers.id, row.id)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.admin.query("DELETE FROM customers WHERE id = $1", [row.id]),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(t.current.admin.query("TRUNCATE customers CASCADE")).rejects.toSatisfy(
      isImmutableRowError,
    );
    await expect(
      t.current.admin.query("UPDATE customers SET id = $2 WHERE id = $1", [row.id, uuidv7()]),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.admin.query("UPDATE customers SET operator_id = $2 WHERE id = $1", [
        row.id,
        b.operatorId,
      ]),
    ).rejects.toSatisfy(isImmutableRowError);
    const [updated] = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .update(customers)
        .set({ name: "Ramesh K.", status: "inactive", phone: "9876500000" })
        .where(eq(customers.id, row.id))
        .returning(),
    );
    expect(updated).toMatchObject({ name: "Ramesh K.", status: "inactive", phone: "9876500000" });
  });

  it("search: trigram name matching and prefix look-ups use the search indexes", async () => {
    const tenant = await createTenant(t.current);
    await insertCustomer(tenant, {
      name: "Ramesh Kumar",
      customerCode: "R-101",
      phone: "9811111111",
    });
    await insertCustomer(tenant, {
      name: "Suresh Yadav",
      customerCode: "S-202",
      phone: "9822222222",
    });
    await insertCustomer(tenant, {
      name: "Mahesh Gupta",
      customerCode: "M-303",
      altPhone: "9833333333",
    });
    const byName = await t.current.db.withTenant(tenant.operatorId, async (tx) => {
      const result = await tx.execute<{ name: string }>(
        sql`SELECT name FROM customers WHERE name % 'ramesh kumr' ORDER BY similarity(name, 'ramesh kumr') DESC`,
      );
      return result.rows.map((r) => r.name);
    });
    expect(byName[0]).toBe("Ramesh Kumar");
    const byPrefix = await t.current.db.withTenant(tenant.operatorId, async (tx) => ({
      code: (
        await tx.execute<{ name: string }>(
          sql`SELECT name FROM customers WHERE customer_code_norm LIKE 'S-2%'`,
        )
      ).rows,
      phone: (
        await tx.execute<{ name: string }>(
          sql`SELECT name FROM customers WHERE alt_phone LIKE '98333%'`,
        )
      ).rows,
    }));
    expect(byPrefix).toEqual({
      code: [{ name: "Suresh Yadav" }],
      phone: [{ name: "Mahesh Gupta" }],
    });

    // The planner picks each index for its look-up. Enough rows (and statistics) that a
    // tenant-wide scan is clearly worse; sequential scans disabled to make the choice visible.
    await t.current.admin.query(
      `INSERT INTO customers (id, operator_id, customer_code, name, phone, alt_phone)
       SELECT gen_random_uuid(), $1, 'G-' || i, 'Generated ' || i, '97' || lpad(i::text, 8, '0'),
              '96' || lpad(i::text, 8, '0')
         FROM generate_series(1, 3000) AS i`,
      [tenant.operatorId],
    );
    await t.current.admin.query("ANALYZE customers");
    const client = await t.current.admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = async (where: string) =>
        (
          await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT id FROM customers WHERE ${where}`,
          )
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
      expect(await plan("name % 'ramesh'")).toContain("customers_name_trgm_idx");
      expect(await plan("name ILIKE '%mesh%'")).toContain("customers_name_trgm_idx");
      expect(
        await plan(`operator_id = '${tenant.operatorId}' AND customer_code_norm LIKE 'R-1%'`),
      ).toContain("customers_code_prefix_idx");
      expect(await plan(`operator_id = '${tenant.operatorId}' AND phone LIKE '981%'`)).toContain(
        "customers_phone_idx",
      );
      expect(
        await plan(`operator_id = '${tenant.operatorId}' AND alt_phone = '9833333333'`),
      ).toContain("customers_alt_phone_idx");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

describeDb("customer_contact_changes", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  let ownerA: string;
  let ownerB: string;
  let customerA: string;
  let customerB: string;

  const change = (overrides: Partial<typeof customerContactChanges.$inferInsert> = {}) => ({
    id: uuidv7(),
    operatorId: a.operatorId,
    customerId: customerA,
    field: "phone" as const,
    oldValue: null,
    newValue: "9876543210",
    actorId: ownerA,
    source: "web" as const,
    ...overrides,
  });
  const insertChange = (overrides: Partial<typeof customerContactChanges.$inferInsert> = {}) => {
    const row = change(overrides);
    return t.current.db.withTenant(row.operatorId, (tx) =>
      tx.insert(customerContactChanges).values(row).returning(),
    );
  };

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    ownerA = (await createUser(t.current, { operatorId: a.operatorId })).userId;
    ownerB = (await createUser(t.current, { operatorId: b.operatorId })).userId;
    customerA = uuidv7();
    customerB = uuidv7();
    await t.current.admin.query(
      "INSERT INTO customers (id, operator_id, customer_code, name) VALUES ($1, $2, '1', 'A'), ($3, $4, '1', 'B')",
      [customerA, a.operatorId, customerB, b.operatorId],
    );
  });

  it("FR-004: records old/new value, actor, time and source", async () => {
    const [row] = await insertChange({
      oldValue: "9811111111",
      newValue: "9822222222",
      source: "android",
    });
    expect(row).toMatchObject({
      field: "phone",
      oldValue: "9811111111",
      newValue: "9822222222",
      actorId: ownerA,
      source: "android",
    });
    expect(row?.at).toBeInstanceOf(Date);
    // Imports may have no actor; web/android changes must have one; a no-op is not a change.
    await expect(insertChange({ actorId: null, source: "import" })).resolves.toHaveLength(1);
    await expect(insertChange({ actorId: null, source: "web" })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
    await expect(
      insertChange({ oldValue: "9811111111", newValue: "9811111111" }),
    ).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
  });

  it("is append-only for every role", async () => {
    const [row] = await insertChange({ field: "alt_phone" });
    if (!row) throw new Error("no row");
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx
          .update(customerContactChanges)
          .set({ newValue: "9000000000" })
          .where(eq(customerContactChanges.id, row.id)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.delete(customerContactChanges).where(eq(customerContactChanges.id, row.id)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.admin.query("DELETE FROM customer_contact_changes WHERE id = $1", [row.id]),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(t.current.admin.query("TRUNCATE customer_contact_changes")).rejects.toSatisfy(
      isImmutableRowError,
    );
  });

  it("composite FKs: can't reference another tenant's customer or user; RLS hides rows", async () => {
    await expect(insertChange({ customerId: customerB })).rejects.toSatisfy(
      failsWith(FK_VIOLATION),
    );
    await expect(insertChange({ actorId: ownerB })).rejects.toSatisfy(failsWith(FK_VIOLATION));
    await expect(
      t.current.admin.query(
        `INSERT INTO customer_contact_changes (id, operator_id, customer_id, field, new_value, actor_id, source)
         VALUES ($1, $2, $3, 'phone', '9876543210', $4, 'web')`,
        [uuidv7(), a.operatorId, customerB, ownerA],
      ),
    ).rejects.toSatisfy(failsWith(FK_VIOLATION));
    await insertChange();
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(customerContactChanges),
    );
    expect(seenByB).toEqual([]);
  });
});
