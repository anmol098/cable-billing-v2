/**
 * @cb/contracts: the mobile API contract v1 (`/api/mobile/v1`) as Zod schemas; emits openapi.json.
 *
 * Server routes (T-028, T-060, T-061) validate requests and responses with these schemas; the
 * Android app (T-063…) generates its DTOs from `openapi.json` and decodes `fixtures/` in its tests.
 * Rules for changing anything here: README.md ("additive only within v1").
 */
export const packageName = "@cb/contracts";

export * from "./app-config";
export * from "./auth";
export * from "./collections";
export * from "./customers";
export * from "./endpoints";
export * from "./envelope";
export * from "./errors";
export * from "./payments";
export * from "./primitives";
export * from "./receipts";
export * from "./sync";
