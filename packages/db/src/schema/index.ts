/**
 * The Drizzle schema: one module per area (`src/schema/<module>.ts`), re-exported here.
 * Shared file (tasks/README.md §6): append your module's `export * from "./<module>";` line only.
 * drizzle.config.ts reads this file to generate migrations; `createDb` passes it to Drizzle.
 */
export * from "./audit";
export * from "./auth";
export * from "./billing";
export * from "./collections";
export * from "./connections";
export * from "./counters";
export * from "./customers";
export * from "./handovers";
export * from "./invariants";
export * from "./jobs";
export * from "./ledger";
export * from "./payments";
export * from "./plans";
export * from "./platform-admin";
export * from "./receipts";
export * from "./roster";
export * from "./subscriptions";
export * from "./sync-metrics";
export * from "./tenancy";
