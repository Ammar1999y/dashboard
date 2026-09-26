import { defineConfig } from 'drizzle-kit';

/**
 * For `bun run db:generate` only, which reads `db/schema.ts` and writes SQL
 * into `db/drizzle/` without connecting.
 *
 * No `dbCredentials` and no `DATABASE_URL` check, deliberately: every
 * drizzle-kit command that would use them connects through a driver this
 * project does not have (the client is `bun:sql`), and requiring the variable
 * would fail `db:generate` where there is a schema but no database. Migrations
 * are applied by `scripts/migrate.ts`.
 */
export default defineConfig({
  out: './db/drizzle',
  schema: './db/schema.ts',
  dialect: 'postgresql',
});
