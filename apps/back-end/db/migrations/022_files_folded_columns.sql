-- Rewrites the table under an ACCESS EXCLUSIVE lock, accepted while no
-- production data exists. One table per file, so each lock ends early.
ALTER TABLE files
  -- squawk-ignore adding-field-with-default
  ADD COLUMN IF NOT EXISTS display_name_folded text GENERATED ALWAYS AS (search_fold(display_name)) STORED;
