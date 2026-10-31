-- The folded columns start with no statistics, so until autovacuum reaches a
-- quiet table the planner estimates their searches at default selectivity.
ANALYZE users (name_folded, email_folded);
ANALYZE roles (role_name_folded, description_folded);
ANALYZE files (display_name_folded);
ANALYZE folders (name_folded);
