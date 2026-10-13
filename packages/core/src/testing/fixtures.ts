/**
 * Test fixtures for core services: a tenant with one user per role, a lineman device and a
 * subscription row; real TenantContexts for them; a runtime with a strict, captured logger.
 */
import type { DbClient, SubscriptionStatus } from "@cb/db";
import { createTenant, createUser, type TestDatabase } from "@cb/db/testing";
import type { TenantRole } from "../authz/capabilities";
import { createServiceRuntime, newRequestId, type ServiceRuntime } from "../context/runtime";
import {
  type Channel,
  issueTenantContext,
  resolveTenantContext,
  type TenantContext,
} from "../context/tenant-context";
import { createLogger, type Logger, type LogRecord } from "../logging/logger";

export interface SeededTenant {
  readonly operatorId: string;
  readonly name: string;
  /** User ids, one per role. */
  readonly users: Readonly<Record<TenantRole, string>>;
  /** The lineman's (non-revoked) device. */
  readonly deviceId: string;
}

export interface SeedTenantOptions {
  /** The subscription row's status. Default `active`; `null` creates no row (read-only). */
  readonly subscription?: SubscriptionStatus | null;
  readonly name?: string;
}

let deviceSequence = 0;

/**
 * Creates a tenant (through the admin pool, like @cb/db's `createTenant`): the operator, an owner,
 * a staff member and a lineman, the lineman's device and a subscription row.
 */
export async function seedTenant(
  database: Pick<TestDatabase, "admin">,
  options: SeedTenantOptions = {},
): Promise<SeededTenant> {
  const tenant = await createTenant(database, options.name ? { name: options.name } : {});
  const { operatorId } = tenant;
  const owner = await createUser(database, { operatorId, role: "owner" });
  const staff = await createUser(database, { operatorId, role: "staff" });
  const lineman = await createUser(database, { operatorId, role: "lineman" });
  deviceSequence += 1;
  const code = (deviceSequence % 36 ** 3).toString(36).toUpperCase().padStart(3, "0");
  const device = await database.admin.query<{ id: string }>(
    `INSERT INTO devices (id, operator_id, user_id, install_id, device_code, model)
     VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, 'test') RETURNING id`,
    [operatorId, lineman.userId, code],
  );
  const deviceId = device.rows[0]?.id;
  if (!deviceId) throw new Error("seedTenant: device insert returned no id");
  const status = options.subscription === undefined ? "active" : options.subscription;
  if (status !== null) await setSubscriptionStatus(database, operatorId, status);
  return {
    operatorId,
    name: tenant.name,
    users: { owner: owner.userId, staff: staff.userId, lineman: lineman.userId },
    deviceId,
  };
}

/** Creates or replaces the tenant's subscription row with `status` (dates filled as required). */
export async function setSubscriptionStatus(
  database: Pick<TestDatabase, "admin">,
  operatorId: string,
  status: SubscriptionStatus,
): Promise<void> {
  await database.admin.query(
    `INSERT INTO subscriptions (operator_id, status, trial_ends_at, grace_ends_at)
     VALUES ($1, $2, now() + interval '30 days', now() + interval '15 days')
     ON CONFLICT (operator_id) DO UPDATE SET status = EXCLUDED.status`,
    [operatorId, status],
  );
}

/** The channel each role signs in on (D-16). */
export function channelOf(role: TenantRole): Channel {
  return role === "lineman" ? "mobile" : "web";
}

/**
 * A real TenantContext for a seeded user, built by `resolveTenantContext` (so tests exercise the
 * production builder). Throws if it fails.
 */
export async function contextFor(
  runtime: Pick<ServiceRuntime, "db">,
  tenant: SeededTenant,
  role: TenantRole,
): Promise<TenantContext> {
  const channel = channelOf(role);
  const result = await resolveTenantContext(runtime, {
    userId: tenant.users[role],
    channel,
    ...(channel === "mobile" ? { deviceId: tenant.deviceId } : {}),
    requestId: newRequestId(),
  });
  if (!result.ok) throw new Error(`contextFor(${role}): ${result.error.code}`);
  return result.value;
}

/**
 * A TenantContext without a database (pure unit tests only: it skips every check
 * `resolveTenantContext` makes). Never use outside tests.
 */
export function unverifiedTestContext(fields: {
  operatorId: string;
  userId: string;
  role: TenantRole;
  deviceId?: string;
  requestId?: string;
}): TenantContext {
  const channel = channelOf(fields.role);
  return issueTenantContext({
    operatorId: fields.operatorId,
    userId: fields.userId,
    role: fields.role,
    channel,
    ...(fields.deviceId === undefined ? {} : { deviceId: fields.deviceId }),
    requestId: fields.requestId ?? newRequestId(),
  });
}

export interface LogCapture {
  readonly logger: Logger;
  readonly records: LogRecord[];
}

/** A strict logger (throws on PII) that keeps records in memory. */
export function captureLogs(): LogCapture {
  const records: LogRecord[] = [];
  return { records, logger: createLogger({ sink: (r) => records.push(r), strict: true }) };
}

/** A runtime over a test database client, with a strict captured logger and an optional clock. */
export function testRuntime(
  db: DbClient,
  options: { now?: () => Date; logs?: LogCapture } = {},
): ServiceRuntime & { readonly records: LogRecord[] } {
  const logs = options.logs ?? captureLogs();
  const runtime = createServiceRuntime({
    db,
    logger: logs.logger,
    ...(options.now ? { now: options.now } : {}),
  });
  return { ...runtime, records: logs.records };
}
