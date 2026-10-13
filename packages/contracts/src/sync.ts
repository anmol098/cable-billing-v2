/**
 * `GET /sync/customers` (PLAN §10.3): delta sync of the whole tenant roster with an
 * `(updated_at, id)` cursor and tombstones. Served by T-060, consumed by T-064.
 *
 * Protocol:
 * 1. First sync (or after CURSOR_INVALID): no cursor. Pages until `has_more` is false. When it ends,
 *    the phone's roster is exactly the active customers received; drop anything else.
 * 2. Later syncs: send the stored `next_cursor`. Upsert `customers`, delete `removed_customer_ids`.
 * 3. Always store `next_cursor` (even when `has_more` is false): it is where the next delta starts.
 */

import * as z from "zod";
import { RosterCustomer } from "./customers";
import { responseBody } from "./envelope";
import { Cursor, Uuid } from "./primitives";

export const ROSTER_PAGE_MAX = 500;

export const SyncCustomersQuery = z.object({
  cursor: Cursor.optional().describe(
    "The next_cursor from the previous sync. Omit for a full sync from the start.",
  ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ROSTER_PAGE_MAX)
    .optional()
    .describe(
      `Maximum rows (customers + removed ids) in this page, 1–${ROSTER_PAGE_MAX}. Default ${ROSTER_PAGE_MAX}.`,
    ),
});

export type SyncCustomersQuery = z.infer<typeof SyncCustomersQuery>;

export const SyncCustomersResponse = responseBody(
  "SyncCustomersResponse",
  "One page of roster changes, ordered by (updated_at, id). Send gzip-accepting requests: about 1,000 customers fit in under 1 MB gzipped.",
  {
    customers: z
      .array(RosterCustomer)
      .describe("Active customers that are new or changed since the cursor. Upsert by id."),
    removed_customer_ids: z
      .array(Uuid)
      .describe(
        "Tombstones: customers deactivated since the cursor. Delete them from the phone (queued payments for them are kept and still synced).",
      ),
    next_cursor: Cursor.describe(
      "Where the next page or the next delta sync starts. Always present; store it after applying this page.",
    ),
    has_more: z
      .boolean()
      .describe("True if more changes are waiting: request again at once with next_cursor."),
  },
);

export type SyncCustomersResponse = z.infer<typeof SyncCustomersResponse>;
