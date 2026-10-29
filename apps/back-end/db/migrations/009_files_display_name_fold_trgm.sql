CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_display_name_active_fold_trgm
  ON files USING gin (search_fold(display_name) gin_trgm_ops)
  WHERE status = 'active';
