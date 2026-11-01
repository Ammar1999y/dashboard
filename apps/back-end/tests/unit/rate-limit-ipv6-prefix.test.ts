/**
 * Per-IP limits key IPv6 on the /64, and a host can be routed a whole /48:
 * 65 536 separate budgets. `enforceIpRateLimit` charges the /48 too, at
 * `IPV6_PREFIX_LIMIT_MULTIPLIER` times the limit, so rotating /64s inside one
 * prefix buys no more than that.
 */
import { beforeEach, expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';

import {
  enforceIpRateLimit,
  IPV6_PREFIX_LIMIT_MULTIPLIER,
} from '@/lib/rate-limit';

import { resetSqliteStores } from '../helpers/sqlite';

const LIMIT = 3;
const tooMany = { status: HTTP_STATUS.TOO_MANY_REQUESTS };

const scopeSeed = { value: 0 };
const scope = () => `test.ipv6prefix${scopeSeed.value++}`;

function charge(scopeName: string, ip: string): Promise<void> {
  return enforceIpRateLimit({
    scope: scopeName,
    headers: new Headers({ 'cf-connecting-ip': ip }),
    limit: LIMIT,
    window: 60,
    failClosed: true,
  });
}

beforeEach(() => {
  resetSqliteStores();
});

test('fresh /64s inside one /48 share the prefix budget', async () => {
  const name = scope();
  const prefixBudget = LIMIT * IPV6_PREFIX_LIMIT_MULTIPLIER;
  // One request from each /64, never near its own limit.
  for (let n = 0; n < prefixBudget; n++)
    await charge(name, `2001:db8:1:${n.toString(16)}::1`);
  await expect(charge(name, '2001:db8:1:ffff::1')).rejects.toMatchObject(
    tooMany
  );
  // Another /48 is untouched.
  await charge(name, '2001:db8:2:1::1');
});

test('a single /64 still stops at its own limit', async () => {
  const name = scope();
  for (let n = 0; n < LIMIT; n++) await charge(name, '2001:db8:3:1::1');
  await expect(charge(name, '2001:db8:3:1::2')).rejects.toMatchObject(tooMany);
});

test('a compressed address lands in the same /48 as its expanded form', async () => {
  const name = scope();
  const prefixBudget = LIMIT * IPV6_PREFIX_LIMIT_MULTIPLIER;
  for (let n = 0; n < prefixBudget; n++)
    await charge(name, `2001:0db8:0004:${n.toString(16)}:0:0:0:1`);
  await expect(charge(name, '2001:db8:4::1')).rejects.toMatchObject(tooMany);
});

test('IPv4 is charged once, with no prefix bucket', async () => {
  const name = scope();
  for (let n = 0; n < LIMIT; n++) await charge(name, '198.51.100.7');
  await expect(charge(name, '198.51.100.7')).rejects.toMatchObject(tooMany);
  await charge(name, '198.51.100.8');
});

test('an IPv4 host in IPv6 form is charged as that host, with no prefix bucket', async () => {
  const name = scope();
  for (let n = 0; n < LIMIT; n++) await charge(name, '::ffff:102:304');
  // The same host, spelled the dotted way, shares the budget.
  await expect(charge(name, '::ffff:1.2.3.4')).rejects.toMatchObject(tooMany);
  // Hosts behind the mapped prefix are not pooled into one /48.
  for (let n = 1; n <= LIMIT * IPV6_PREFIX_LIMIT_MULTIPLIER; n++)
    await charge(name, `::ffff:10.0.${n >> 8}.${n & 255}`);
});
