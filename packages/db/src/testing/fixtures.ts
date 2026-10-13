/**
 * Test fixtures. Every test should make its own tenants so tests in one file stay independent.
 *
 * `createTenant` inserts the `operators` row (T-021) through the admin pool (creating a tenant is
 * a platform action, and seeding must not depend on the code under test), so tenant tables with a
 * foreign key to `operators` can be seeded. It creates nothing else: tests add the users,
 * subscription or counters they need.
 */
import { uuidv7 } from "../ids";
import type { TestDatabase } from "./database";

export interface TestTenant {
  /** The tenant id to pass to `withTenant`. */
  readonly operatorId: string;
  readonly name: string;
}

let sequence = 0;

/** Creates a tenant (an `operators` row with default settings) for a test. */
export async function createTenant(
  database: Pick<TestDatabase, "admin">,
  overrides: Partial<Pick<TestTenant, "name">> = {},
): Promise<TestTenant> {
  sequence += 1;
  const tenant = { operatorId: uuidv7(), name: overrides.name ?? `Test Cable ${sequence}` };
  await database.admin.query("INSERT INTO operators (id, name) VALUES ($1, $2)", [
    tenant.operatorId,
    tenant.name,
  ]);
  return tenant;
}

export interface TestUser {
  readonly userId: string;
  /** NULL for a platform admin. */
  readonly operatorId: string | null;
  readonly role: "owner" | "staff" | "lineman" | "platform_admin";
  readonly login: string;
}

/**
 * Creates a user through the admin pool (no password/account row). Pass `operatorId: null` for a
 * platform admin (it gets an email, which platform admins require). Default role: `owner` with a
 * tenant, `platform_admin` without.
 */
export async function createUser(
  database: Pick<TestDatabase, "admin">,
  options: {
    operatorId: string | null;
    role?: TestUser["role"];
    login?: string;
    name?: string;
    language?: "hi" | "en";
  },
): Promise<TestUser> {
  sequence += 1;
  const role = options.role ?? (options.operatorId === null ? "platform_admin" : "owner");
  const userId = uuidv7();
  const login = options.login ?? `user${sequence}_${userId.slice(-8)}`;
  const email = role === "platform_admin" ? `${login}@admin.test` : null;
  await database.admin.query(
    `INSERT INTO users (id, operator_id, role, name, login, email, language)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      options.operatorId,
      role,
      options.name ?? `Test User ${sequence}`,
      login,
      email,
      options.language ?? (role === "lineman" ? "hi" : "en"),
    ],
  );
  return { userId, operatorId: options.operatorId, role, login };
}
