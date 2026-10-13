/**
 * Test fixtures. Every test should make its own tenants so tests in one file stay independent.
 *
 * T-021 note: `operators` doesn't exist yet (T-021 adds it). Once it does, createTenant must also
 * insert the operator row (through `db.admin`, since creating a tenant is a platform action), so
 * tenant tables with a foreign key to operators can be seeded. Keep the signature.
 */
import { uuidv7 } from "../ids";
import type { TestDatabase } from "./database";

export interface TestTenant {
  /** The tenant id to pass to `withTenant`. */
  readonly operatorId: string;
  readonly name: string;
}

let sequence = 0;

/** Creates a tenant for a test. */
export async function createTenant(
  _database: TestDatabase,
  overrides: Partial<Pick<TestTenant, "name">> = {},
): Promise<TestTenant> {
  sequence += 1;
  return { operatorId: uuidv7(), name: overrides.name ?? `Test Cable ${sequence}` };
}
