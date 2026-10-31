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

import { HTTP_STATUS } from '@app/shared/http-status';

import { BETTER_AUTH_ROUTE_PREFIX } from '@/lib/auth/allowed-paths';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { isJsonSchema } from '@/lib/http/openapi/json-schema';
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

test('the Google callback publishes the query it validates', async () => {
  const document = await servedDocument();
  const item = document.paths['/api/auth/oauth/google/callback'];
  const operation = isJsonSchema(item) ? item.get : undefined;
  const parameters =
    isJsonSchema(operation) && Array.isArray(operation.parameters)
      ? operation.parameters.filter(isJsonSchema)
      : [];
  const state = parameters.find(({ name }) => name === 'state');
  expect(state).toMatchObject({
    in: 'query',
    required: true,
    schema: { type: 'string', pattern: '^[\\w-]{32}$' },
  });
  expect(
    parameters
      .filter(({ required }) => required === true)
      .map(({ name }) => name)
  ).toEqual(['state']);

  for (const query of ['?code=x', '?code=x&state=short']) {
    const response = await app.handle(
      new Request(
        `${PUBLIC_ORIGIN}${BETTER_AUTH_ROUTE_PREFIX.prefix}/oauth/google/callback${query}`,
        { headers: baseHeaders() }
      )
    );
    expect([query, response.status]).toEqual([query, HTTP_STATUS.BAD_REQUEST]);
  }
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
