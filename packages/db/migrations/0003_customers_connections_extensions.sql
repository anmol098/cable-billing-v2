-- T-022 custom SQL, before the tables: pg_trgm provides the gin_trgm_ops operator class used by
-- customers_name_trgm_idx (customer search by name, T-033) and similarity()/% for ranking.
-- Trusted extension (PG13+) available on Neon; installed in the default schema like btree_gist
-- (migration 0000), whose uuid/date support the vc_assignments EXCLUDE constraint needs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
