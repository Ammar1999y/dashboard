-- ux_users_email without its `deleted_at IS NULL` predicate, which kept
-- Better Auth's email-only lookup off the index. Built under a temporary name
-- beside the old one, which 014 drops and 015 replaces by name, so uniqueness
-- over live rows never lapses. Soft delete rewrites the email, so deleted rows
-- do not collide.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_users_email_all
  ON users (email);
