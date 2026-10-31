CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_role_id
  ON users (role_id);
