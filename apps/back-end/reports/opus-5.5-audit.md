# Back-end audit (Opus 5.5)

Whole-codebase audit of `apps/back-end` and the `packages/shared` sources it imports, against `CLAUDE.md`. Paths are relative to `apps/back-end/`; `shared/` means `packages/shared/src/`.

Entries are numbered in one sequence: findings by severity, then improvements by gain against cost, then stale owner entries. Fixed entries are removed without renumbering, so a number always names the same entry.

## Stale entries

Every other stale entry is resolved in the owner documents. These two record opposite decisions in the documents and the code, so the owner decides.

- **197.** **TODO "Do later 6" and should-ignore Known #9 (soft-deleted users accumulate):** both say a purge comes later; the code records the opposite decision, "deliberately NO purge sweep" (`db/schema.ts`, `lib/maintenance/database.ts`), because the `audit_logs.user_id` restrict foreign key would make a purge fail.
- **214.** **`reports/coolify-deployment.md` §3.3 idle-in-transaction timeout:** the runbook sets the role to 10 s, but `db/index.ts` sends `idle_in_transaction_session_timeout: 60000` as a connection setting, which overrides the role (PostgreSQL 18.6: value 60000, source `client`). The runbook now explains the override; which value the app should run with is open.
