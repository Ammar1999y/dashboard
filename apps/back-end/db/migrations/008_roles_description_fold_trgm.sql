CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_description_fold_trgm
  ON roles USING gin (search_fold(description) gin_trgm_ops)
  WHERE description IS NOT NULL;
