/**
 * `reauth` and `checksPassword` on a route decide what its 401 and 429 publish,
 * so each is held to the handler it declares. A handler reaches either gate
 * directly or through the functions below, and a new caller of the
 * primitives fails the last test until it is listed here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ROUTES } from '@/routes';

import { PASSWORD_PROOF_PATHS } from '@/lib/auth/path-policy';
import { BETTER_AUTH_PASSWORD_LOCKOUT_PATHS } from '@/lib/http/openapi/better-auth-tables';

import { compareCodeUnits } from '@/utils/text';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

const REAUTH_GATE =
  /reauth: true|requireReauthWindow\(|authorizeContactChange\(|editUserAsAdmin\(/;
const PASSWORD_GATE =
  /verifyLoginAttempt\(|verifySessionPassword\(|authorizeContactChange\(/;

/** The only modules outside `app/` that call the primitives; see the header. */
const PRIMITIVE_CALLERS = [
  'lib/auth/path-policy.ts',
  'lib/auth/reauth/password.ts',
  'lib/users/contact-change.ts',
  'lib/users/edit.ts',
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Each exported method's own source: the text up to the next export. */
function methodSources(source: string): Map<string, string> {
  const sources = new Map<string, string>();
  const starts = source
    .matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)
    .toArray();
  for (const [index, match] of starts.entries())
    sources.set(
      match[1] ?? '',
      source.slice(match.index, starts[index + 1]?.index)
    );
  return sources;
}

const handlerFiles = Iterator.from(
  new Bun.Glob('app/api/**/handler.ts').scanSync(REPO_ROOT)
).toArray();

describe('every route declares the gates its handler reaches', () => {
  test.each(handlerFiles)('%s', async (file) => {
    const location = path.join(REPO_ROOT, file);
    // eslint-disable-next-line no-unsanitized/method -- a handler the glob above found in this repository
    const module: Record<string, unknown> = await import(location);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the same file
    const sources = methodSources(readFileSync(location, 'utf8'));
    for (const method of METHODS) {
      const handler = module[method];
      if (typeof handler !== 'function') continue;
      const route = ROUTES.find((entry) => entry.handler === handler);
      if (!route) continue;
      const source = sources.get(method) ?? '';
      const label = `${route.method} ${route.path}`;
      expect(route.reauth ?? false, label).toBe(REAUTH_GATE.test(source));
      expect(route.checksPassword ?? false, label).toBe(
        PASSWORD_GATE.test(source)
      );
    }
  });

  test('the Better Auth lockout list is every endpoint that checks the password', () => {
    // A proof the hook takes (`PASSWORD_PROOF_PATHS`), or one the endpoint
    // asks for itself.
    const checked = new Set(PASSWORD_PROOF_PATHS);
    const files = new Bun.Glob('lib/auth/**/*.ts').scanSync(REPO_ROOT);
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file the glob above found in this repository
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const endpoints = source
        .matchAll(/createAuthEndpoint\(\s*'([^']+)'/g)
        .toArray();
      for (const [index, match] of endpoints.entries()) {
        const body = source.slice(match.index, endpoints[index + 1]?.index);
        if (/requireReauthPassword\(|verifyReauthPassword\(/.test(body))
          checked.add(match[1] ?? '');
      }
    }
    expect(
      [...BETTER_AUTH_PASSWORD_LOCKOUT_PATHS].toSorted(compareCodeUnits)
    ).toEqual([...checked].toSorted(compareCodeUnits));
  });

  test('no other module calls the primitives', () => {
    const callers = Iterator.from(
      new Bun.Glob('lib/**/*.ts').scanSync(REPO_ROOT)
    )
      .map((file) => file.replaceAll(path.sep, '/'))
      .filter((file) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file the glob above found in this repository
        const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
        return (
          /(?<!function )(?:requireReauthWindow|verifyLoginAttempt)\(/.test(
            source
          ) &&
          !file.endsWith('lib/auth/reauth/window.ts') &&
          !file.endsWith('lib/auth/login-guard.ts')
        );
      })
      .toArray()
      .toSorted(compareCodeUnits);
    expect(callers).toEqual(PRIMITIVE_CALLERS);
  });
});
