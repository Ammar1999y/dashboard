/**
 * Each plugin endpoint's shared entry against what the server serves: its
 * allowlist row and the endpoint Better Auth mounted. `pluginEndpoint` takes
 * the path and method from the entry, so a mismatch here is the allowlist or
 * the policy drifting from the handler.
 */
import { describe, expect, test } from 'bun:test';

import { PLUGIN_ENDPOINTS } from '@app/shared/api/all';

import { auth } from '@/lib/auth';
import {
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_KNOWN_ENDPOINTS,
} from '@/lib/auth/allowed-paths';

const ROWS = new Map(BETTER_AUTH_KNOWN_ENDPOINTS.map((row) => [row.path, row]));

interface Mounted {
  path: string;
  options: { method: unknown };
}

const isMounted = (value: unknown): value is Mounted =>
  typeof value === 'function' &&
  'path' in value &&
  typeof value.path === 'string' &&
  'options' in value &&
  typeof value.options === 'object' &&
  value.options !== null &&
  'method' in value.options;

const MOUNTED = new Map(
  Object.values(auth.api)
    .filter(isMounted)
    .map((endpoint) => [endpoint.path, endpoint])
);

describe('plugin endpoint entries', () => {
  test.each([...PLUGIN_ENDPOINTS])(
    '%s matches its allowlist row',
    (path, entry) => {
      const row = ROWS.get(path);
      expect(row).toBeDefined();
      expect(row?.methods).toEqual([entry.method]);
      expect(row?.captcha).toBe(entry.policy.captcha);
      // A challenge cookie or no session at all is a public entry.
      expect(row?.session === 'session').toBe(entry.policy.auth === 'session');
    }
  );

  test('every enabled one is mounted at its path with its method', () => {
    const enabled = BETTER_AUTH_ENDPOINTS.filter(({ path }) =>
      PLUGIN_ENDPOINTS.has(path)
    );
    expect(enabled.length).toBeGreaterThan(0);
    for (const { path } of enabled) {
      const endpoint = MOUNTED.get(path);
      const entry = PLUGIN_ENDPOINTS.get(path);
      const mounted: unknown[] = [path, endpoint?.options.method];
      expect(mounted).toEqual([path, entry?.method]);
    }
  });
});
