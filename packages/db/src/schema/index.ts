/**
 * The Drizzle schema: one module per area (`src/schema/<module>.ts`), re-exported here.
 * Shared file (tasks/README.md §6): append your module's `export * from "./<module>";` line only.
 * drizzle.config.ts reads this file to generate migrations; `createDb` passes it to Drizzle.
 */
export * from "./audit";
export * from "./auth";
export * from "./counters";
export * from "./subscriptions";
export * from "./tenancy";
