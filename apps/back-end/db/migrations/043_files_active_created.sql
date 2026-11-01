CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_active_created
  ON files (created_at, id)
  WHERE status = 'active' AND folder_id IS NOT NULL;
