/**
 * Unique values for e2e seeds.
 *
 * Call `newSeedId()` **inside `test.beforeAll`** and derive every value that must be unique in the
 * database from it (logins, emails, mobiles, business names, row ids the tests look up). Never
 * make them at module or `describe` level: Playwright loads a spec file once per worker process but
 * runs `beforeAll` once per test group, and with `fullyParallel` a file is split into several
 * groups, so one worker can seed the same file twice. A value made when the file loaded is then
 * reused by the second seed and collides on `users_login_unique` / `users_email_unique` (or a
 * primary key) instead of running the tests. A fresh id per seed also makes retries, worker
 * restarts and `--repeat-each` safe against the same database.
 */
import { randomBytes } from "node:crypto";

/** A short random hex id (8 characters by default) for one seed. */
export function newSeedId(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

/** A 10-digit Indian mobile number (starts with 9) derived from a seed id, so it is unique per seed. */
export function mobileFromSeed(seedId: string): string {
  return `9${String(Number.parseInt(seedId.slice(0, 8), 16) % 1_000_000_000).padStart(9, "0")}`;
}
