/**
 * The storage health route is reachable without a token (`preAuthIpLimit:
 * false`), so what a refusal logs is anyone's to trigger.
 */
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';

import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';
import { maintenanceTokenMatches } from '@/lib/maintenance/token';

const spies = [
  spyOn(console, 'error').mockImplementation(() => {}),
  spyOn(console, 'warn').mockImplementation(() => {}),
] as const;
const [errors, warnings] = spies;

afterEach(() => {
  for (const spy of spies) spy.mockClear();
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

test.each([
  ['a wrong token', 'not-the-token'],
  ['no token', null],
])('%s is refused at warn, never at error level', (_, provided) => {
  expect(SQLITE_MAINTENANCE_TOKEN.length).toBeGreaterThan(0);

  expect(maintenanceTokenMatches(provided)).toBe(false);

  expect(errors).not.toHaveBeenCalled();
  expect(warnings).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toMatchObject({
    msg: 'maintenance token rejected',
    configured: true,
  });
});

test('the configured token matches and logs nothing', () => {
  expect(maintenanceTokenMatches(SQLITE_MAINTENANCE_TOKEN)).toBe(true);
  expect(errors).not.toHaveBeenCalled();
  expect(warnings).not.toHaveBeenCalled();
});
