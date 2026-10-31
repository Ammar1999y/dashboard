-- One issuer per provider (`chk_credential_issuer`, `chk_google_account`), so
-- ux_accounts_provider_account already enforces this.
DROP INDEX CONCURRENTLY IF EXISTS ux_accounts_issuer_account;
