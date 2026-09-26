import { assertPasswordHashEvaluable } from '@/lib/auth/password/hash';

import { connectPreflightDatabase } from './preflight-database';

const sql = connectPreflightDatabase();
try {
  const rows = await sql<{ id: string; password: string }[]>`
    SELECT id, password
    FROM accounts
    WHERE provider_id = 'credential'
  `;
  const failures: string[] = [];
  for (const row of rows) {
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
  console.log(
    JSON.stringify({
      msg: 'password pepper preflight passed',
      credentials: rows.length,
    })
  );
} finally {
  await sql.close();
}
