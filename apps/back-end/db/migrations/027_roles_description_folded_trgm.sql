CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_description_folded_trgm
  ON roles USING gin (description_folded gin_trgm_ops)
  WHERE description_folded IS NOT NULL;
