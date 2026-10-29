CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_fold_trgm
  ON users USING gin (search_fold(email) gin_trgm_ops)
  WHERE deleted_at IS NULL;
