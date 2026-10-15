/**
 * Error helpers shared by the T-061 mobile endpoints (payment batch, collections, receipts):
 * core field names → contract wire paths, per-item errors for the batch endpoints, and the item
 * id a batch result echoes.
 *
 * Messages are developer English for logs: field **names** only, never request values or PII.
 */
import { type ErrorCode, Uuid } from "@cb/contracts";
import type { FieldProblem as FieldIssue } from "@/lib/mobile/http";

/**
 * The id a batch result carries for an item whose own id is unusable (missing or not a UUID the
 * contract accepts). Matches no item the phone has, so the phone keeps whatever it sent and shows
 * nothing new.
 */
export const UNUSABLE_ITEM_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The item's id in canonical lower case, or {@link UNUSABLE_ITEM_ID}.
 *
 * Checked with the contract's own `Uuid` (RFC 9562 version and variant digits), not `isUuid`
 * (any hex in UUID shape): the result echoes this id and the whole answer is validated against
 * the contract before it leaves, so an id the contract refuses would turn the answer into a 500
 * after the batch's other items were already saved. Such an item also fails the item schema (same
 * `Uuid`), so it is `rejected` VALIDATION on its own and never posted.
 */
export function itemIdOf(raw: unknown): string {
  const id = Uuid.safeParse((raw as { id?: unknown } | null)?.id);
  return id.success ? id.data.toLowerCase() : UNUSABLE_ITEM_ID;
}

/** Core input names that are not just camelCase of the wire name. */
const RENAMED: Readonly<Record<string, string>> = {
  claimedCollectorId: "collector_id",
  claimedDeviceId: "device_id",
  businessDate: "date",
  // A payment id first used by a counter or migrated payment: the id is what clashes.
  source: "id",
};

/** `amountPaise` → `amount_paise`; `a.b` paths are converted segment by segment. */
export function wireName(coreName: string): string {
  return coreName
    .split(".")
    .map((segment) => RENAMED[segment] ?? segment.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join(".");
}

/**
 * A core VALIDATION error's `details.fields` (`{ path, code }`, camelCase paths) as contract
 * `FieldIssue`s under `prefix` (e.g. `payments.3`).
 */
export function coreFieldIssues(details: unknown, prefix?: string): FieldIssue[] {
  const fields = (details as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter(
      (f): f is { path: string; code: string } =>
        typeof f?.path === "string" && typeof f?.code === "string",
    )
    .slice(0, 50)
    .map((f) => ({
      path: [prefix, wireName(f.path)].filter(Boolean).join("."),
      issue: f.code,
    }));
}

/** ID_REUSED_WITH_DIFFERENT_DATA `details.fields` (core names) → wire names, for the message. */
export function differingFields(details: unknown): string[] {
  const fields = (details as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((f): f is string => typeof f === "string").map(wireName);
}

export interface ItemErrorWire {
  readonly code: ErrorCode;
  readonly message: string;
  readonly fields?: FieldIssue[];
}

/** A per-item error (contract `ItemError`). `fields` only for VALIDATION. */
export function itemError(
  code: ErrorCode,
  message: string,
  fields?: readonly FieldIssue[],
): ItemErrorWire {
  return {
    code,
    message: message.slice(0, 1000),
    ...(code === "VALIDATION" && fields && fields.length > 0 ? { fields: [...fields] } : {}),
  };
}
