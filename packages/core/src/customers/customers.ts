/**
 * Customer write services (T-033; FR-003, FR-004, RULE-02, PLAN §7.2, §7.3, §12.1).
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `customers.create` | `customers.manage` (Owner, Staff) | New customer; empty code → next number from the `customer_code` counter |
 * | `customers.update` | `customers.manage` | Change code, name, phones, address, area (patch: missing = keep, `null` = clear) |
 * | `customers.set_status` | `customers.manage` | Deactivate (`inactive`) / reactivate (`active`) |
 * | `customers.update_phone` | `customers.phone.update` (Owner, Staff, Lineman) | Correct one number (the lineman's receipt flow, FR-004) |
 *
 * Rules:
 * - **Code** (RULE-02): unique per operator after normalisation (`customer_code_norm`, T-022). A
 *   taken code is CONFLICT with `details: { field: "customerCode", reason: "duplicate_code",
 *   customerId }` (the customer that has it, same tenant). A concurrent insert that wins the race
 *   surfaces as CONFLICT with `details.constraint = "customers_operator_code_unique"`; use
 *   {@link isDuplicateCustomerCode} for both.
 * - **Auto code**: `{seq}` from the gap-free `customer_code` counter, skipping numbers already
 *   typed by hand (the counter jumps past the highest all-digit code once it hits a taken one).
 * - **Phones** are cleaned with `normalizePhone` (a bad number is VALIDATION on its field, code
 *   `custom`). Every change of `phone` / `alt_phone` after creation writes one
 *   `customer_contact_changes` row (old, new, actor, time, source `web` | `android` from the
 *   channel) in the same transaction (FR-004). Creating a customer writes no history row; its
 *   audit event has the first numbers.
 * - **Deactivate** is refused while a connection is not disconnected (CONFLICT, `details.reason =
 *   "open_connections"`, `details.openConnections`): billing follows connections (T-040), so an
 *   inactive customer with a running connection would still get bills. Stop the connections first
 *   (T-034). Reactivating is always allowed. Nothing is ever deleted.
 * - Every write sets `updated_at` (the lineman roster syncs by it, PLAN §10.3) and records one
 *   audit event with the changed fields only (`before`/`after`; KYC is redacted by the recorder).
 *   A call that changes nothing records no event (`audit.skip("no_change")`).
 * - Ids from another tenant (customer, area) are NOT_FOUND, with nothing written.
 */
import {
  areas,
  customerContactChanges,
  customers,
  nextCounter,
  normalizeCustomerCode,
  type Tx,
  uuidv7,
  vcAssignments,
} from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditRecorder } from "../audit/audit";
import { defineService } from "../context/service";
import type { Channel } from "../context/tenant-context";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../errors/errors";
import { CUSTOMER_FIELD_LIMITS, normalizePhone } from "./rules";
import type { CreateCustomerResult, CustomerView, UpdateCustomerResult } from "./types";

type CustomerError = ServiceError<CoreErrorCode>;

// ---------------------------------------------------------------------------------------------
// Input pieces
// ---------------------------------------------------------------------------------------------

const id = () => z.uuid().transform((value) => value.toLowerCase());

/** A phone field: "" / null → no number; otherwise cleaned, or VALIDATION (`custom`). */
const phoneField = () =>
  z
    .string()
    .max(CUSTOMER_FIELD_LIMITS.phoneInput)
    .nullable()
    .transform((value, ctx) => {
      if (value === null || value.trim() === "") return null;
      const phone = normalizePhone(value);
      if (phone === null) {
        ctx.addIssue({ code: "custom", message: "phone_invalid" });
        return z.NEVER;
      }
      return phone;
    });

/** Optional free text: trimmed; "" → null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));

/** A code as typed (trimmed), at most 64 characters once normalised; "" allowed (caller decides). */
const codeField = () =>
  z
    .string()
    .max(CUSTOMER_FIELD_LIMITS.customerCode * 2)
    .transform((value) => value.trim())
    .refine((value) => normalizeCustomerCode(value).length <= CUSTOMER_FIELD_LIMITS.customerCode, {
      message: "code_too_long",
    });

const nameField = () => z.string().trim().min(1).max(CUSTOMER_FIELD_LIMITS.name);

/** KYC metadata (FR-003): a few short text values, e.g. `{ "id_type": "Voter ID" }`. Optional. */
const kycField = () =>
  z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().trim().max(200))
    .refine((value) => Object.keys(value).length <= 10, { message: "too_many_keys" });

export const CreateCustomerInput = z.object({
  /** Empty or missing → the next number from the counter. */
  customerCode: codeField().nullish(),
  name: nameField(),
  phone: phoneField().optional(),
  altPhone: phoneField().optional(),
  address: optionalText(CUSTOMER_FIELD_LIMITS.address).optional(),
  areaId: id().nullish(),
  kyc: kycField().optional(),
});
export type CreateCustomerCommand = z.output<typeof CreateCustomerInput>;

export const UpdateCustomerInput = z.object({
  customerId: id(),
  /** The code can change but not become empty. */
  customerCode: codeField()
    .refine((value) => value !== "", { message: "required" })
    .optional(),
  name: nameField().optional(),
  phone: phoneField().optional(),
  altPhone: phoneField().optional(),
  address: optionalText(CUSTOMER_FIELD_LIMITS.address).optional(),
  areaId: id().nullable().optional(),
  kyc: kycField().optional(),
});
export type UpdateCustomerCommand = z.output<typeof UpdateCustomerInput>;

export const SetCustomerStatusInput = z.object({
  customerId: id(),
  status: z.enum(["active", "inactive"]),
});

export const UpdateCustomerPhoneInput = z.object({
  customerId: id(),
  /** Which number. Default the main one. */
  field: z.enum(["phone", "alt_phone"]).default("phone"),
  /** The new number; `null` / "" removes it. */
  phone: phoneField(),
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type CustomerRow = typeof customers.$inferSelect;

export function toCustomerView(row: CustomerRow): CustomerView {
  return {
    id: row.id,
    customerCode: row.customerCode,
    name: row.name,
    phone: row.phone,
    altPhone: row.altPhone,
    address: row.address,
    areaId: row.areaId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The duplicate-code error, from the friendly pre-check or from the unique index (a race). */
export function isDuplicateCustomerCode(error: ServiceError<string>): boolean {
  if (error.code !== "CONFLICT") return false;
  return (
    error.details?.reason === "duplicate_code" ||
    error.details?.constraint === "customers_operator_code_unique"
  );
}

function duplicateCode(customerId: string): CustomerError {
  return serviceError("CONFLICT", "Customer code is already used", {
    field: "customerCode",
    reason: "duplicate_code",
    customerId,
  });
}

function fieldError(path: string, code: string): CustomerError {
  return serviceError("VALIDATION", "Input failed validation", { fields: [{ path, code }] });
}

/** The customer (same tenant) that has this normalised code, other than `exceptId`. */
async function customerWithCode(
  tx: Tx,
  operatorId: string,
  code: string,
  exceptId?: string,
): Promise<string | null> {
  const conditions = [
    eq(customers.operatorId, operatorId),
    eq(customers.customerCodeNorm, normalizeCustomerCode(code)),
  ];
  if (exceptId) conditions.push(ne(customers.id, exceptId));
  const [row] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(...conditions))
    .limit(1);
  return row?.id ?? null;
}

/** Moves the counter past the highest all-digit code (typed by hand or imported). */
async function skipPastTypedCodes(tx: Tx, operatorId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE counters SET next_value = m.top + 1
    FROM (
      SELECT max(customer_code_norm::bigint) AS top FROM customers
      WHERE operator_id = ${operatorId} AND customer_code_norm ~ '^[1-9][0-9]{0,17}$'
    ) m
    WHERE counters.operator_id = ${operatorId} AND counters.name = 'customer_code'
      AND m.top IS NOT NULL AND counters.next_value <= m.top`);
}

const AUTO_CODE_ATTEMPTS = 5;

/** The next free auto code (`{seq}`), taken from the counter in this transaction. */
async function takeAutoCode(tx: Tx, operatorId: string): Promise<Result<string, CustomerError>> {
  for (let attempt = 0; attempt < AUTO_CODE_ATTEMPTS; attempt += 1) {
    const code = String(await nextCounter(tx, operatorId, "customer_code"));
    if ((await customerWithCode(tx, operatorId, code)) === null) return ok(code);
    if (attempt === 0) await skipPastTypedCodes(tx, operatorId);
  }
  return err(
    serviceError("CONFLICT", "No free automatic customer code", {
      field: "customerCode",
      reason: "auto_code_unavailable",
      retryable: true,
    }),
  );
}

/** An area of this tenant: NOT_FOUND for a missing / other tenant's id. */
async function checkArea(
  tx: Tx,
  operatorId: string,
  areaId: string,
  { allowArchived }: { allowArchived: boolean },
): Promise<Result<void, CustomerError>> {
  const [area] = await tx
    .select({ archivedAt: areas.archivedAt })
    .from(areas)
    .where(and(eq(areas.operatorId, operatorId), eq(areas.id, areaId)));
  if (!area) return err(notFound());
  if (area.archivedAt && !allowArchived) return err(fieldError("areaId", "archived"));
  return ok(undefined);
}

const CONTACT_SOURCE: Record<Channel, "web" | "android"> = { web: "web", mobile: "android" };

/** Who acts, as the in-transaction helpers need it (a TenantContext fits). */
export interface CustomerActor {
  readonly operatorId: string;
  readonly userId: string;
  readonly channel: Channel;
}

async function recordContactChange(
  tx: Tx,
  actor: CustomerActor,
  customerId: string,
  field: "phone" | "alt_phone",
  oldValue: string | null,
  newValue: string | null,
  now: Date,
): Promise<void> {
  await tx.insert(customerContactChanges).values({
    id: uuidv7(),
    operatorId: actor.operatorId,
    customerId,
    field,
    oldValue,
    newValue,
    actorId: actor.userId,
    source: CONTACT_SOURCE[actor.channel],
    at: now,
  });
}

/** The audited fields of a customer (what `before` / `after` show). */
type AuditFields = Partial<
  Record<"customerCode" | "name" | "phone" | "altPhone" | "address" | "areaId" | "status", unknown>
> & { kyc?: unknown };

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/**
 * Creates a customer inside the caller's tenant transaction and records its audit event. Public
 * so a composite service (T-034: customer + connections in one transaction) can reuse it; plain
 * callers use {@link createCustomer}.
 */
export async function createCustomerInTx(
  tx: Tx,
  actor: CustomerActor,
  input: CreateCustomerCommand,
  now: Date,
  audit: AuditRecorder,
): Promise<Result<CreateCustomerResult, CustomerError>> {
  const { operatorId } = actor;
  if (input.areaId) {
    const area = await checkArea(tx, operatorId, input.areaId, { allowArchived: false });
    if (!area.ok) return area;
  }

  const typed = input.customerCode ?? "";
  let code: string;
  if (typed === "") {
    const auto = await takeAutoCode(tx, operatorId);
    if (!auto.ok) return auto;
    code = auto.value;
  } else {
    const holder = await customerWithCode(tx, operatorId, typed);
    if (holder) return err(duplicateCode(holder));
    code = typed;
  }

  const [row] = await tx
    .insert(customers)
    .values({
      id: uuidv7(),
      operatorId,
      customerCode: code,
      name: input.name,
      phone: input.phone ?? null,
      altPhone: input.altPhone ?? null,
      address: input.address ?? null,
      areaId: input.areaId ?? null,
      kyc: input.kyc ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("customer insert returned no row");

  const after: AuditFields = {
    customerCode: row.customerCode,
    name: row.name,
    phone: row.phone,
    altPhone: row.altPhone,
    address: row.address,
    areaId: row.areaId,
    status: row.status,
    ...(input.kyc ? { kyc: input.kyc } : {}),
  };
  await audit.record({ entityType: "customer", entityId: row.id, after });
  return ok({ customer: toCustomerView(row), autoCode: typed === "" });
}

export const createCustomer = defineService({
  name: "customers.create",
  capability: "customers.manage",
  input: CreateCustomerInput,
  async run({ ctx, input, tx, audit, now }) {
    return createCustomerInTx(tx, ctx, input, now, audit);
  },
});

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

async function lockCustomer(tx: Tx, operatorId: string, customerId: string) {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, customerId)))
    .for("update");
  return row ?? null;
}

async function saveChanges(
  tx: Tx,
  actor: CustomerActor,
  before: CustomerRow,
  patch: Partial<
    Pick<
      CustomerRow,
      "customerCode" | "name" | "phone" | "altPhone" | "address" | "areaId" | "status" | "kyc"
    >
  >,
  now: Date,
  audit: AuditRecorder,
): Promise<UpdateCustomerResult> {
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((key) =>
    key === "kyc"
      ? JSON.stringify(patch.kyc) !== JSON.stringify(before.kyc)
      : patch[key] !== undefined && patch[key] !== before[key],
  );
  if (changed.length === 0) {
    audit.skip("no_change");
    return { customer: toCustomerView(before), changed: [] };
  }

  const set: Partial<typeof customers.$inferInsert> = { updatedAt: now };
  const beforeAudit: Record<string, unknown> = {};
  const afterAudit: Record<string, unknown> = {};
  for (const key of changed) {
    Object.assign(set, { [key]: patch[key] });
    beforeAudit[key] = before[key];
    afterAudit[key] = patch[key];
  }
  const [after] = await tx
    .update(customers)
    .set(set)
    .where(and(eq(customers.operatorId, actor.operatorId), eq(customers.id, before.id)))
    .returning();
  if (!after) throw new Error("customer update returned no row");

  if (changed.includes("phone")) {
    await recordContactChange(tx, actor, before.id, "phone", before.phone, after.phone, now);
  }
  if (changed.includes("altPhone")) {
    await recordContactChange(
      tx,
      actor,
      before.id,
      "alt_phone",
      before.altPhone,
      after.altPhone,
      now,
    );
  }
  await audit.record({
    entityType: "customer",
    entityId: before.id,
    before: beforeAudit,
    after: afterAudit,
  });
  return { customer: toCustomerView(after), changed };
}

export const updateCustomer = defineService({
  name: "customers.update",
  capability: "customers.manage",
  input: UpdateCustomerInput,
  async run({ ctx, input, tx, audit, now }) {
    const before = await lockCustomer(tx, ctx.operatorId, input.customerId);
    if (!before) return err(notFound());

    if (input.areaId && input.areaId !== before.areaId) {
      const area = await checkArea(tx, ctx.operatorId, input.areaId, { allowArchived: false });
      if (!area.ok) return area;
    }
    if (input.customerCode !== undefined) {
      const holder = await customerWithCode(tx, ctx.operatorId, input.customerCode, before.id);
      if (holder) return err(duplicateCode(holder));
    }

    return ok(
      await saveChanges(
        tx,
        ctx,
        before,
        {
          customerCode: input.customerCode,
          name: input.name,
          phone: input.phone,
          altPhone: input.altPhone,
          address: input.address,
          areaId: input.areaId,
          ...(input.kyc === undefined ? {} : { kyc: input.kyc }),
        },
        now,
        audit,
      ),
    );
  },
});

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/** Connections of a customer that are not disconnected (active or stopped). */
async function openConnectionCount(tx: Tx, operatorId: string, customerId: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(vcAssignments)
    .where(
      and(
        eq(vcAssignments.operatorId, operatorId),
        eq(vcAssignments.customerId, customerId),
        ne(vcAssignments.status, "disconnected"),
      ),
    );
  return row?.n ?? 0;
}

export const setCustomerStatus = defineService({
  name: "customers.set_status",
  capability: "customers.manage",
  input: SetCustomerStatusInput,
  async run({ ctx, input, tx, audit, now }) {
    const before = await lockCustomer(tx, ctx.operatorId, input.customerId);
    if (!before) return err(notFound());
    if (input.status === "inactive" && before.status !== "inactive") {
      const open = await openConnectionCount(tx, ctx.operatorId, before.id);
      if (open > 0) {
        return err(
          serviceError("CONFLICT", "Customer still has connections", {
            reason: "open_connections",
            openConnections: open,
          }),
        );
      }
    }
    return ok(await saveChanges(tx, ctx, before, { status: input.status }, now, audit));
  },
});

// ---------------------------------------------------------------------------------------------
// One phone number (lineman receipt flow, FR-004)
// ---------------------------------------------------------------------------------------------

export const updateCustomerPhone = defineService({
  name: "customers.update_phone",
  capability: "customers.phone.update",
  input: UpdateCustomerPhoneInput,
  async run({ ctx, input, tx, audit, now }) {
    const before = await lockCustomer(tx, ctx.operatorId, input.customerId);
    if (!before) return err(notFound());
    const patch = input.field === "phone" ? { phone: input.phone } : { altPhone: input.phone };
    return ok(await saveChanges(tx, ctx, before, patch, now, audit));
  },
});
