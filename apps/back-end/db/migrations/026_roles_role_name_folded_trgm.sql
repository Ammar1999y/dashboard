CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_role_name_folded_trgm
  ON roles USING gin (role_name_folded gin_trgm_ops);
