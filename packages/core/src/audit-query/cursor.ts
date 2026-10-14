/**
 * Keyset cursor of the audit list (T-035): the `(at, id)` of the last event shown. The list is
 * ordered `at DESC, id DESC` (index `audit_events_operator_at_idx`), and the next page is
 * `(at, id) < (cursor.at, cursor.id)`, so a page never repeats or skips an event when new events
 * arrive while someone pages (new events sort before the first page).
 *
 * `at` keeps Postgres's microseconds (a JS `Date` has milliseconds only: rounding would skip or
 * repeat events written in the same millisecond). The cursor is opaque text (base64url); it only
 * narrows the caller's own tenant's events, so a forged one can't reach anything else.
 */

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuditCursor {
  /** UTC instant with microseconds, `2026-10-14T06:30:49.438123Z`. */
  readonly at: string;
  readonly id: string;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

/** The cursor, or `null` when the text is not one this module made. */
export function decodeAuditCursor(text: string): AuditCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) return null;
  const decoded = Buffer.from(text, "base64url").toString("utf8");
  const [at, id, ...rest] = decoded.split("|");
  if (rest.length > 0 || !at || !id || !AT.test(at) || !UUID.test(id)) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}
