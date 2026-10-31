CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_folded_trgm
  ON users USING gin (name_folded gin_trgm_ops)
  WHERE deleted_at IS NULL;
