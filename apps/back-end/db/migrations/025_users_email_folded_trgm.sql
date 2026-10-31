CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_folded_trgm
  ON users USING gin (email_folded gin_trgm_ops)
  WHERE deleted_at IS NULL;
