/**
 * drizzle-kit config. Generate: `pnpm --filter @cb/db db:generate [--custom] --name=<what>`.
 * Apply: `pnpm --filter @cb/db db:migrate` (runs as the owner role from DATABASE_URL_UNPOOLED,
 * falling back to DATABASE_URL). All migrations must run as that same role: migration 0000's
 * default privileges grant the app roles access only to tables that role creates.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "",
  },
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  // Roles are created by migration 0000, not managed by drizzle-kit.
  entities: { roles: false },
  strict: true,
  verbose: true,
});
