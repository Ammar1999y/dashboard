/**
 * The provisioner's decisions that need no server: what a failed clone
 * leaves behind, and when a harness database counts as abandoned
 * (`tests/helpers/provision.ts`).
 */
import { describe, expect, test } from 'bun:test';

import { compareCodeUnits } from '@/utils/text';

import { newRunToken, workerDatabaseName } from '../helpers/names';
import {
  createWorkerDatabases,
  harnessDatabaseIdleMs,
  LEASE_RENEW_MS,
  leaseComment,
  renewLeases,
} from '../helpers/provision';

const NOW_MS = 1_787_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const TOKEN = newRunToken(NOW_MS, 'abc123');

/**
 * Records every statement. One that `refuses` rejects at once; the rest hold
 * until `finish`, so a rejection lands while its siblings are in flight.
 */
function fakeClient(refuses: (query: string) => boolean = () => false) {
  const statements: string[] = [];
  const held = Promise.withResolvers<void>();
  return {
    statements,
    unsafe: async (query: string) => {
      statements.push(query);
      if (refuses(query)) throw new Error(`refused: ${query}`);
      await held.promise;
    },
    finish: () => held.resolve(),
  };
}

const workers = [1, 2, 3].map((worker) => workerDatabaseName(TOKEN, worker));
const [first = '', second = '', third = ''] = workers;

const dropped = (statements: readonly string[]) =>
  statements
    .filter((statement) => statement.startsWith('drop database'))
    .map((statement) => /"([^"]+)"/.exec(statement)?.[1] ?? statement)
    .toSorted(compareCodeUnits);

/** The rejection `done` settles with, once `client` lets its clones finish. */
async function failureOf(
  done: Promise<unknown>,
  client: ReturnType<typeof fakeClient>
): Promise<AggregateError> {
  let settled = false;
  const watched = done.finally(() => {
    settled = true;
  });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  client.finish();
  const error = await watched
    .then(() => null)
    .catch((reason: unknown) => reason);
  if (!(error instanceof AggregateError))
    throw new Error('expected an AggregateError');
  return error;
}

describe('createWorkerDatabases', () => {
  test('returns every clone once all of them exist, dropping none', async () => {
    const client = fakeClient();
    const done = createWorkerDatabases(client, TOKEN, 3);
    client.finish();
    expect(await done).toEqual(workers);
    expect(dropped(client.statements)).toEqual([]);
  });

  test('a failed clone drops its siblings once they settled, then throws', async () => {
    const client = fakeClient(
      (query) => query.startsWith('create') && query.includes(second)
    );
    const error = await failureOf(
      createWorkerDatabases(client, TOKEN, 3),
      client
    );
    expect(error.errors).toHaveLength(1);
    expect(error.message).toBe('1 of 3 worker database clone(s) failed');
    expect(dropped(client.statements)).toEqual([first, third]);
  });

  test('a sibling that will not drop is named in the failure', async () => {
    const client = fakeClient(
      (query) =>
        (query.startsWith('create') && query.includes(second)) ||
        (query.startsWith('drop') && query.includes(third))
    );
    const error = await failureOf(
      createWorkerDatabases(client, TOKEN, 3),
      client
    );
    expect(error.message).toContain(`; ${third} would not drop`);
  });
});

describe('the lease', () => {
  const name = workerDatabaseName(TOKEN, 1);

  test('a database never renewed is as idle as its name is old', () => {
    expect(harnessDatabaseIdleMs(name, null, NOW_MS + 3 * HOUR_MS)).toBe(
      3 * HOUR_MS
    );
    expect(harnessDatabaseIdleMs(name, 'a note', NOW_MS + HOUR_MS)).toBe(
      HOUR_MS
    );
  });

  test('a renewal resets idleness, however old the name', () => {
    const later = NOW_MS + 5 * HOUR_MS;
    expect(
      harnessDatabaseIdleMs(name, leaseComment(later - LEASE_RENEW_MS), later)
    ).toBe(LEASE_RENEW_MS);
  });

  test('a lease from the future, or an unreadable name, is never reclaimable', () => {
    expect(
      harnessDatabaseIdleMs(name, leaseComment(NOW_MS + HOUR_MS), NOW_MS)
    ).toBeNull();
    expect(
      harnessDatabaseIdleMs('app_harness_template_test', null, NOW_MS)
    ).toBeNull();
  });

  test('renewal comments on each database, from a time it refuses to misread', async () => {
    const client = fakeClient();
    client.finish();
    await renewLeases(client, [name], NOW_MS);
    expect(client.statements).toEqual([
      `comment on database "${name}" is 'harness-lease:${NOW_MS}'`,
    ]);
    expect(() => leaseComment(NaN)).toThrow();
    expect(() => leaseComment(1.5)).toThrow();
  });
});
