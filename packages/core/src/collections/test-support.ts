/**
 * Test support for the collection services' tests (not exported from the package; no side
 * effects, so the isolation discovery can import it).
 */
import { type DbClient, paymentReversals, payments, type Tx, uuidv7 } from "@cb/db";
import { createUser, type TestDatabase } from "@cb/db/testing";
import { and, eq, isNull, sql } from "drizzle-orm";
import { newRequestId, type ServiceRuntime } from "../context/runtime";
import { resolveTenantContext, type TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import { reversePayment } from "../payments/reverse-payment";
import { insertCustomer } from "../payments/test-support";
import type { SeededTenant } from "../testing/fixtures";

/** Adds a lineman with their own phone; returns the user, the device and a mobile context. */
export async function addLineman(
  database: Pick<TestDatabase, "admin">,
  runtime: Pick<ServiceRuntime, "db">,
  tenant: SeededTenant,
  options: { name?: string; deviceCode: string },
): Promise<{ userId: string; deviceId: string; ctx: TenantContext }> {
  const user = await createUser(database, {
    operatorId: tenant.operatorId,
    role: "lineman",
    ...(options.name ? { name: options.name } : {}),
  });
  const device = await database.admin.query<{ id: string }>(
    `INSERT INTO devices (id, operator_id, user_id, install_id, device_code, model)
     VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, 'test') RETURNING id`,
    [tenant.operatorId, user.userId, options.deviceCode],
  );
  const deviceId = device.rows[0]?.id;
  if (!deviceId) throw new Error("addLineman: no device");
  const ctx = await resolveTenantContext(runtime, {
    userId: user.userId,
    channel: "mobile",
    deviceId,
    requestId: newRequestId(),
  });
  if (!ctx.ok) throw new Error(`addLineman: ${ctx.error.code}`);
  return { userId: user.userId, deviceId, ctx: ctx.value };
}

/** Sets `last_seen_at` of every phone of a user. */
export async function setLastSeen(
  database: Pick<TestDatabase, "admin">,
  userId: string,
  at: Date | null,
): Promise<void> {
  await database.admin.query("UPDATE devices SET last_seen_at = $2 WHERE user_id = $1", [
    userId,
    at,
  ]);
}

/** A customer of the tenant. */
export function newCustomer(db: DbClient, tenant: SeededTenant): Promise<string> {
  return db.withTenant(tenant.operatorId, (tx) => insertCustomer(tx, tenant.operatorId));
}

/** Posts a field payment as `ctx` (a lineman), recorded at `recordedAt`. Returns the payment id. */
export async function postField(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  customerId: string,
  amountPaise: number,
  method: "cash" | "upi",
  recordedAt: Date,
): Promise<string> {
  const id = uuidv7();
  const result = await postPayment.call(runtime, ctx, {
    id,
    customerId,
    amountPaise,
    method,
    ...(method === "upi" ? { upiReference: "123456789012" } : {}),
    recordedAt: recordedAt.toISOString(),
    provisionalRef: "P-TST-0001",
    claimedCollectorId: ctx.userId,
    ...(ctx.deviceId ? { claimedDeviceId: ctx.deviceId } : {}),
  });
  if (!result.ok) throw new Error(`postField: ${result.error.code}`);
  return id;
}

/** Reverses a payment as the owner. */
export async function reverse(
  runtime: ServiceRuntime,
  owner: TenantContext,
  paymentId: string,
): Promise<void> {
  const result = await reversePayment.call(runtime, owner, { paymentId, reason: "Wrong customer" });
  if (!result.ok) throw new Error(`reverse: ${result.error.code}`);
}

/**
 * The expected-cash rule recomputed from the payments themselves (`rules.ts`): Android payments
 * of the collector on the day, not reversed; cash and UPI apart.
 */
export async function recomputeTotals(
  tx: Tx,
  operatorId: string,
  collectorId: string,
  date: string,
): Promise<{ cash: number; upi: number; count: number }> {
  const [row] = await tx
    .select({
      cash: sql<string>`coalesce(sum(${payments.amountPaise}) FILTER (WHERE ${payments.method} = 'cash'), 0)`,
      upi: sql<string>`coalesce(sum(${payments.amountPaise}) FILTER (WHERE ${payments.method} = 'upi'), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(
      and(
        eq(payments.operatorId, operatorId),
        eq(payments.collectorId, collectorId),
        eq(payments.businessDate, date),
        eq(payments.source, "android"),
        isNull(paymentReversals.id),
      ),
    );
  return { cash: Number(row?.cash ?? 0), upi: Number(row?.upi ?? 0), count: Number(row?.count) };
}
