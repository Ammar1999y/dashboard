CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_folders_name_fold_trgm
  ON folders USING gin (search_fold(name) gin_trgm_ops);
