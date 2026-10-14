-- Run before pg_restore on the target database (restore-drill.sh does it). pg_dump does not dump
-- roles, but the dump GRANTs to app_rw / app_platform and RLS policies name them. Same block as
-- packages/db/migrations/0000_foundation.sql: create the roles if this server/branch lacks them
-- (a brand-new Neon project) and make the restoring (owner) role a member, so withTenant /
-- withPlatform can SET LOCAL ROLE. A Neon branch of the production project already has both.
-- The runtime login role (cb_app) is NOT created here: environments.md §4.12 makes it by hand.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'app_rw', 'MEMBER') THEN
    EXECUTE format('GRANT app_rw TO %I', current_user);
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'app_platform', 'MEMBER') THEN
    EXECUTE format('GRANT app_platform TO %I', current_user);
  END IF;
END
$$;
