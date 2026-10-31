CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_folder_active
  ON files (folder_id, size_bytes)
  WHERE status = 'active';
