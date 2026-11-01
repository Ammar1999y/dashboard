-- No query orders by lower(display_name), so nothing reads this index; every
-- file insert and rename paid to maintain it.
DROP INDEX CONCURRENTLY IF EXISTS idx_files_folder_name;
