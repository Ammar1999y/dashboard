import { SQL } from 'bun';

/** One short-lived connection to `DATABASE_URL`, for the read-only preflights. */
export function connectPreflightDatabase(): SQL {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return new SQL(databaseUrl, { max: 1, connectionTimeout: 10 });
}
