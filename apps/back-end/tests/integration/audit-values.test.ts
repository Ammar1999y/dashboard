/**
 * What `auditLog` stores for values that are not plain JSON on the way in, read
 * back from the real `jsonb` columns: a value the redactor reshapes silently is
 * an audit trail that records something other than what happened.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { auditLogs } from '@/db/schema';

import { auditLog } from '@/lib/audit';
import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';
import { seedUser } from '../helpers/session';

const fixture: { user?: SeededUser } = {};
function user(): SeededUser {
  if (!fixture.user) throw new Error('user not seeded');
  return fixture.user;
}

async function audited(
  oldData: Record<string, unknown>
): Promise<{ oldData: unknown }> {
  const recordId = generateUuidV7();
  await withTransaction((tx) =>
    auditLog(tx, {
      userId: user().userId,
      userEmail: user().email,
      action: 'UPDATE',
      tableName: 'users',
      recordId,
      oldData,
      newData: { label: 'after' },
      meta: { ip: null, userAgent: null, apiPath: '/audit-values' },
    })
  );
  const [row] = await db
    .select({ oldData: auditLogs.oldData })
    .from(auditLogs)
    .where(eq(auditLogs.recordId, recordId));
  if (!row) throw new Error('auditLog wrote no row');
  return row;
}

beforeAll(async () => {
  await resetTables();
  fixture.user = await seedUser();
});

describe('audit values', () => {
  test('a Date is stored as its ISO instant, not as an empty object', async () => {
    // The lockout-cleared event recorded `{"lockedUntil":{}}`, losing the time
    // the account had been locked until.
    const lockedUntil = new Date('2026-09-29T10:15:00.000Z');
    const row = await audited({
      lockedUntil,
      nested: { at: [lockedUntil] },
      invalid: new Date(NaN),
    });

    expect(row.oldData).toEqual({
      lockedUntil: '2026-09-29T10:15:00.000Z',
      nested: { at: ['2026-09-29T10:15:00.000Z'] },
      invalid: null,
    });
  });

  test('a truncated preview never cuts a surrogate pair in half', async () => {
    // `{"k":"` is six characters, so the emoji's high surrogate is the 1024th
    // code unit: a code-unit cut left it unpaired and `jsonb` refused the row.
    const value = `${'x'.repeat(1017)}\u{1F600}${'y'.repeat(40_000)}`;
    const row = await audited({ k: value });

    const stored = row.oldData;
    expect(stored).toMatchObject({ _truncated: true });
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('preview' in stored) ||
      typeof stored.preview !== 'string'
    )
      throw new Error('expected a truncated preview');
    expect(stored.preview.isWellFormed()).toBe(true);
    expect(stored.preview.endsWith('\u{1F600}')).toBe(true);
  });
});
