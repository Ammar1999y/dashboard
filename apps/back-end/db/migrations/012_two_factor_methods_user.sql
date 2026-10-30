CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_two_factor_methods_user
  ON two_factor_methods (user_id);
