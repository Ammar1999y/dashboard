import { assertPasswordHashEvaluable } from '@/lib/auth/password/hash';

import { logLine } from '@/utils/log';

import { connectPreflightDatabase } from './preflight-database';

const sql = connectPreflightDatabase();
try {
  const rows = await sql<{ id: string; password: string | null }[]>`
    SELECT id, password
    FROM accounts
    WHERE provider_id = 'credential'
  `;
  const failures: string[] = [];
  for (const row of rows) {
    if (row.password === null) {
      failures.push(row.id);
      continue;
    }
    try {
      assertPasswordHashEvaluable(row.password);
    } catch {
      failures.push(row.id);
    }
  }
  if (failures.length > 0)
    throw new Error(
      `${failures.length} credential hash(es) cannot be evaluated; account ids: ${failures.join(', ')}`
    );
  logLine('log', {
    msg: 'password pepper preflight passed',
    credentials: rows.length,
  });
} finally {
  await sql.close();
}
