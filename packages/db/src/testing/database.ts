/**
 * A fresh, migrated database for one test file, cloned from the template (see template.ts).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, type DbClient } from "../client";
import { APP_PLATFORM_ROLE, APP_RW_ROLE } from "../rls";
import { quoteIdent, testDatabaseUrl, withCredentials, withDatabase } from "./env";
import { connectAdmin, ensureTemplate } from "./template";

export interface TestDatabase {
  /** Database name (`cb_test_<epoch>_<random>`). */
  readonly name: string;
  /** URL of this database with the admin (owner/superuser) credentials. */
  readonly url: string;
  /**
   * The app client under test, connected like production shape A (the owner role, switching to
   * app_rw/app_platform per transaction). Pool of 4.
   */
  readonly db: DbClient;
  /**
   * Raw admin pool on this database. It bypasses RLS: use it to seed or inspect rows in tests,
   * never to test isolation.
   */
  readonly admin: pg.Pool;
  /**
   * Creates a LOGIN role that is a member of app_rw and app_platform but not the owner (production
   * shape B) and returns a URL for it. Dropped with the database.
   */
  createLoginRole(): Promise<{ role: string; url: string }>;
  /** Closes pools and drops the database and its login roles. */
  drop(): Promise<void>;
}

function suffix(): string {
  return `${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}`;
}

const OBJECT_IN_USE = "55006"; // "source database is being accessed by other users"

async function createFromTemplate(client: pg.Client, name: string, template: string) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== OBJECT_IN_USE || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** Creates a migrated database for this test file. Call `drop()` when done (useTestDatabase does). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testDatabaseUrl();
  const template = await ensureTemplate(adminUrl);
  const name = `cb_test_${suffix()}`;
  const loginRoles: string[] = [];

  const control = await connectAdmin(adminUrl);
  try {
    await createFromTemplate(control, name, template);
  } finally {
    await control.end();
  }

  const url = withDatabase(adminUrl, name);
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  admin.on("error", () => {}); // idle connections are force-closed by drop()
  const db = createDb({ connectionString: url, driver: "pg", max: 4, onIdleError: () => {} });
  let dropped = false;

  return {
    name,
    url,
    db,
    admin,
    async createLoginRole() {
      const role = `cb_login_${suffix()}`;
      const password = randomBytes(18).toString("hex");
      await admin.query(
        `CREATE ROLE ${quoteIdent(role)} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}' IN ROLE ${APP_RW_ROLE}, ${APP_PLATFORM_ROLE}`,
      );
      loginRoles.push(role);
      return { role, url: withCredentials(url, role, password) };
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      await Promise.allSettled([db.end(), admin.end()]);
      const client = await connectAdmin(adminUrl);
      try {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
        for (const role of loginRoles)
          await client.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
      } finally {
        await client.end();
      }
    },
  };
}
