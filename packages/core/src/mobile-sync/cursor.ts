/**
 * The roster sync cursor (T-060, contract `Cursor`: opaque to the phone, ≤ 512 characters).
 *
 * **Why transaction ids and not `(updated_at, id)`.** A timestamp cursor skips rows whose
 * transaction took its clock reading before the cursor's time but committed after the read that
 * produced the cursor (a long billing run, a payment waiting on a customer lock). Instead every
 * change records its transaction id (`roster_versions.change_xid`, `xid8`, written by triggers in
 * the writer's transaction), and a cursor keeps the **xmin of the reading snapshot**: every
 * transaction that had not committed when the page was read has an xid ≥ that xmin, so the next
 * sync asks for `change_xid ≥ xmin` and nothing committed late is ever missed. Rows committed
 * before the snapshot with an xid ≥ xmin are sent again (an idempotent upsert on the phone).
 *
 * **One pass, many pages.** A sync "pass" is the run of pages until `has_more` is false. Within a
 * pass the server walks `(change_xid, customer_id)` upwards from the pass's watermark `w`, keeping
 * the last row sent in `k`, and remembers in `n` the smallest snapshot xmin seen since the pass
 * began. A row committed during the pass with a position below `k` has an xid ≥ `n` (it was not
 * committed at the pass's first snapshot), so when the pass ends the next one starts at `w = n`
 * and picks it up. A row that changes again during the pass moves to a higher xid and may be sent
 * twice in the same pass (harmless; the phone keeps the newest `updated_at`).
 *
 * **Full pass** (`f`, no cursor sent): starts at xid 0 and sends active customers only (the phone
 * drops anything it did not receive). Later passes are deltas: inactive customers come as
 * tombstones (`removed_customer_ids`).
 *
 * Fields: `v` version, `o` operator (a cursor only works for the tenant that got it), `w`, `n`,
 * `k = [xid, customer id]`, `f`. Encoded as base64url JSON. Not signed: tampering can only ask for
 * a different slice of the caller's own tenant (the operator check and RLS still apply), and an
 * xid beyond the database's current one (tampered, or a database restored to an earlier point) is
 * refused as CURSOR_INVALID, which makes the phone start a full sync.
 */
import { z } from "zod";

export const CURSOR_VERSION = 1;

/** A decimal `xid8` value. 0 = before every transaction. */
const XID = /^(0|[1-9][0-9]{0,19})$/;
const xid = z.string().regex(XID);

const CursorShape = z
  .object({
    v: z.literal(CURSOR_VERSION),
    o: z.uuid(),
    w: xid,
    n: xid.optional(),
    k: z.tuple([xid, z.uuid()]).optional(),
    f: z.literal(1).optional(),
  })
  .strict();

export interface RosterCursor {
  /** The operator the cursor belongs to (lower case). */
  readonly operatorId: string;
  /** Rows with `change_xid >= watermark` belong to this pass. */
  readonly watermark: string;
  /** The smallest snapshot xmin seen since this pass began (absent on a pass's first page). */
  readonly nextWatermark?: string;
  /** The last row sent in this pass, `[change_xid, customer_id]` (absent on a pass's first page). */
  readonly after?: readonly [string, string];
  /** A full pass: active customers only, no tombstones. */
  readonly full: boolean;
}

/** The cursor of a sync without one: a full pass from the beginning. */
export function fullSyncCursor(operatorId: string): RosterCursor {
  return { operatorId: operatorId.toLowerCase(), watermark: "0", full: true };
}

export function encodeCursor(cursor: RosterCursor): string {
  const body: z.input<typeof CursorShape> = {
    v: CURSOR_VERSION,
    o: cursor.operatorId,
    w: cursor.watermark,
    ...(cursor.nextWatermark === undefined ? {} : { n: cursor.nextWatermark }),
    ...(cursor.after === undefined ? {} : { k: [cursor.after[0], cursor.after[1]] }),
    ...(cursor.full ? { f: 1 as const } : {}),
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** The cursor, or `null` when it is not one of ours (malformed, another version). */
export function decodeCursor(text: string): RosterCursor | null {
  if (text.length === 0 || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = CursorShape.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data;
  return {
    operatorId: c.o.toLowerCase(),
    watermark: c.w,
    ...(c.n === undefined ? {} : { nextWatermark: c.n }),
    ...(c.k === undefined ? {} : { after: [c.k[0], c.k[1].toLowerCase()] as const }),
    full: c.f === 1,
  };
}

/** The smaller of two decimal xids. */
export function minXid(a: string, b: string): string {
  return BigInt(a) <= BigInt(b) ? a : b;
}

/** Is any xid in the cursor beyond `xmax` (not yet assigned in this database)? */
export function cursorIsFromTheFuture(cursor: RosterCursor, xmax: string): boolean {
  const limit = BigInt(xmax);
  return [cursor.watermark, cursor.nextWatermark, cursor.after?.[0]].some(
    (value) => value !== undefined && BigInt(value) > limit,
  );
}
