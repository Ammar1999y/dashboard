CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_fold_trgm
  ON users USING gin (search_fold(name) gin_trgm_ops)
  WHERE deleted_at IS NULL;
