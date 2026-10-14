/**
 * Mobile sync (T-060): the lineman roster delta with tombstones, the fresh customer detail and the
 * roster row after a phone correction. See ./services.ts (services) and ./cursor.ts (the cursor).
 */
export {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  fullSyncCursor,
  type RosterCursor,
} from "./cursor";
export { clip, WIRE_LIMITS } from "./rows";
export {
  getRosterCustomer,
  getRosterCustomerDetail,
  ROSTER_PAGE_SIZE,
  RosterCustomerInput,
  type SyncRosterCommand,
  SyncRosterInput,
  syncRoster,
} from "./services";
export {
  RECENT_PAYMENTS_LIMIT,
  type RosterArea,
  type RosterConnection,
  type RosterCustomerDetail,
  type RosterOpenBill,
  type RosterOpenBills,
  type RosterPage,
  type RosterRecentPayment,
  type RosterRow,
} from "./types";
