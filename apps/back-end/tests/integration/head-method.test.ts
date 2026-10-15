/**
 * HEAD answers as GET would, without the body and with the GET's length.
 *
 * Elysia 2 serves HEAD only from a registered HEAD route, and its
 * `elysia/auto-head` plugin drops the body without keeping its length, so a
 * listener sent `Content-Length: 0` where RFC 9110 §8.6 allows only the GET's
 * length. `app.ts` registers a HEAD route per GET instead; this holds both
 * kinds of registration — a table route and the Better Auth prefix — and the
 * reference page to it, on a success, on the raw document, and on the envelope
 * refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';

import { HTTP_STATUS } from '@app/shared/http-status';

import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';
import { baseHeaders, seedUser, signIn } from '../helpers/session';

interface Case {
  path: string;
  signedIn: boolean;
  /** The GET's own status, so a refusal case cannot quietly become a success. */
  status: number;
}

const CASES: readonly Case[] = [
  { path: '/api/auth/get-session', signedIn: false, status: HTTP_STATUS.OK },
  { path: '/api/dash/permissions', signedIn: true, status: HTTP_STATUS.OK },
  { path: '/openapi.json', signedIn: true, status: HTTP_STATUS.OK },
  // The development reference page, the one route outside `bind()`.
  { path: '/openapi', signedIn: false, status: HTTP_STATUS.OK },
  // Raw, without its token.
  {
    path: '/api/health/storage',
    signedIn: false,
    status: HTTP_STATUS.UNAUTHORIZED,
  },
  {
    path: '/openapi.json',
    signedIn: false,
    status: HTTP_STATUS.UNAUTHORIZED,
  },
  {
    path: '/api/dash/permissions',
    signedIn: false,
    status: HTTP_STATUS.UNAUTHORIZED,
  },
  {
    path: `/api/dash/permissions/${generateUuidV7()}`,
    signedIn: true,
    status: HTTP_STATUS.NOT_FOUND,
  },
  {
    path: '/api/dash/permissions?page=abc',
    signedIn: true,
    status: HTTP_STATUS.UNPROCESSABLE,
  },
];

/**
 * `server-timing` is per response in development, the tier's posture, and a
 * listener's `date` can tick between the two requests.
 */
const PER_RESPONSE = new Set(['content-length', 'server-timing', 'date']);

function comparableHeaders(response: Response): [string, string][] {
  return response.headers
    .entries()
    .filter(([key]) => !PER_RESPONSE.has(key))
    .toArray();
}

const state: { session: SignedInSession | null } = { session: null };

beforeAll(async () => {
  await resetTables();
  state.session = await signIn(await seedUser());
});

function headersFor({ signedIn }: Case): Record<string, string> {
  if (!signedIn) return baseHeaders();
  if (!state.session) throw new Error('fixture not seeded');
  return baseHeaders({ cookie: state.session.cookie });
}

const label = ({ path, signedIn }: Case) =>
  `${path} ${signedIn ? 'signed in' : 'anonymous'}`;

describe('HEAD in-process', () => {
  test.each(CASES.map((entry) => [label(entry), entry] as const))(
    '%s answers as GET, with no body',
    async (_, entry) => {
      const url = `http://localhost${entry.path}`;
      const get = await app.handle(
        new Request(url, { headers: headersFor(entry) })
      );
      const head = await app.handle(
        new Request(url, { method: 'HEAD', headers: headersFor(entry) })
      );
      const getBody = await get.arrayBuffer();

      expect(get.status).toBe(entry.status);
      expect(head.status).toBe(get.status);
      expect(head.body).toBeNull();
      expect(head.headers.get('content-length')).toBe(
        String(getBody.byteLength)
      );
      expect(comparableHeaders(head)).toEqual(comparableHeaders(get));
    }
  );
});

describe('HEAD over a socket', () => {
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  afterAll(() => void server.stop(true));

  test.each(CASES.map((entry) => [label(entry), entry] as const))(
    '%s sends the GET length and headers',
    async (_, entry) => {
      const url = `http://127.0.0.1:${String(server.port)}${entry.path}`;
      const get = await fetch(url, { headers: headersFor(entry) });
      const getBody = await get.arrayBuffer();
      const head = await fetch(url, {
        method: 'HEAD',
        headers: headersFor(entry),
      });

      expect(getBody.byteLength).toBeGreaterThan(0);
      expect(get.status).toBe(entry.status);
      expect(head.status).toBe(get.status);
      expect(head.headers.get('content-length')).toBe(
        String(getBody.byteLength)
      );
      expect(comparableHeaders(head)).toEqual(comparableHeaders(get));
    }
  );
});
