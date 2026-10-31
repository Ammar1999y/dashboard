-- Rewrites the table under an ACCESS EXCLUSIVE lock, accepted while no
-- production data exists. One table per file, so each lock ends early.
ALTER TABLE roles
  -- squawk-ignore adding-field-with-default
  ADD COLUMN IF NOT EXISTS role_name_folded text GENERATED ALWAYS AS (search_fold(role_name)) STORED,
  -- squawk-ignore adding-field-with-default
  ADD COLUMN IF NOT EXISTS description_folded text GENERATED ALWAYS AS (search_fold(description)) STORED;
