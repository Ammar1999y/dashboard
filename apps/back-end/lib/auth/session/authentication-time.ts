import type { Executor } from '@/db';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import * as z from 'zod';

const clockRowSchema = z.object({ milliseconds: z.number().int() });

// Credential revocation uses this database clock; an application timestamp can admit a stale proof under skew.
export async function authenticationStartedAt(
  executor: Executor = db
): Promise<number> {
  const rows = await executor.execute(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::double precision as milliseconds`
  );
  return clockRowSchema.parse(rows[0]).milliseconds;
}
