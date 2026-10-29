CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_role_name_fold_trgm
  ON roles USING gin (search_fold(role_name) gin_trgm_ops);
