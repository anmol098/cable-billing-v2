-- Run right after pg_restore (restore-drill.sh does it). The dump's DEFAULT PRIVILEGES entries name
-- the role that owned the source database, which may not be the role restoring now, so
-- restore-drill.sh skips them and this re-creates migration 0000's default privileges FOR THE
-- CURRENT (owner) ROLE: tables and sequences that later migrations create stay usable by the app
-- roles, and RLS still decides which rows. Keep in step with packages/db/migrations/0000_foundation.sql.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw, app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw, app_platform;
