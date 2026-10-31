-- `lib/http/constraint-errors.ts` maps the violation by this name, so the
-- replacement takes it; no client names the index.
-- squawk-ignore renaming-object
ALTER INDEX ux_users_email_all RENAME TO ux_users_email;
