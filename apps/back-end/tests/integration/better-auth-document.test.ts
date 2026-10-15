/**
 * Every Better Auth operation the document publishes answers within it, asked
 * anonymously, with a session, and with a session but no `Origin`: each
 * status must be published and each body match its schema
 * (`tests/helpers/document-check.ts`). The library's statuses and bodies are
 * the dependency's, so only asking every path proves the merge describes them.
 *
 * `tests/matrix/two-factor-configuration.test.ts` asks the same of each
 * two-factor configuration; this is the full one, with OAuth.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';

import { BETTER_AUTH_ROUTE_PREFIX } from '@/lib/auth/allowed-paths';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { servedDocument } from '@/lib/http/openapi/serve';

import { resetTables } from '../helpers/database';
import { askEveryOperation } from '../helpers/document-check';
import { baseHeaders, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const fixture: { session: SignedInSession | null } = { session: null };

const session = (): SignedInSession => {
  if (!fixture.session) throw new Error('fixture not seeded');
  return fixture.session;
};

beforeAll(async () => {
  await resetTables();
  fixture.session = await signedInUser();
});

describe('every Better Auth operation answers within the document', () => {
  test.each([
    ['anonymously', () => baseHeaders({ origin: PUBLIC_ORIGIN })],
    [
      'with a session and no Origin',
      () => baseHeaders({ cookie: session().cookie }),
    ],
    // Last: it ends at `/sign-out`.
    [
      'with a session',
      () => baseHeaders({ origin: PUBLIC_ORIGIN, cookie: session().cookie }),
    ],
  ] as const)(
    '%s',
    async (_label, headers) => {
      // Each case asks every path once; the admission budgets are per file.
      resetSqliteStores();
      expect(
        await askEveryOperation(
          await servedDocument(),
          BETTER_AUTH_ROUTE_PREFIX.prefix,
          (request) => app.handle(request),
          headers()
        )
      ).toEqual([]);
    },
    60_000
  );
});
