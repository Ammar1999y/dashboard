CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_role_id_live
  ON users (role_id)
  WHERE deleted_at IS NULL;
