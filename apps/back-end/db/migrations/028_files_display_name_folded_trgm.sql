CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_display_name_active_folded_trgm
  ON files USING gin (display_name_folded gin_trgm_ops)
  WHERE status = 'active';
