import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { SeedOptions } from '../helpers/session';
import type { Tx } from '@/db';
import type { OtpPurpose } from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import {
  accounts,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { TransactionDeadlineError } from '@/db/transaction';

import { HTTP_STATUS } from '@app/shared/http-status';
import { CONTACT_LABEL, otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';

import { credentialAccountOf } from '@/lib/auth/credential-account';
import { lockUser } from '@/lib/auth/user-eligibility';
import { RATE_LIMIT_DB_PATH } from '@/lib/env.server';
import { MINIMUM_RESPONSE_MS } from '@/lib/http/timing-floor';
import { runDatabaseSweep } from '@/lib/maintenance/database';
import { processOtpSend } from '@/lib/otp/send';
import * as rateLimit from '@/lib/rate-limit';
import { getRateLimitStore } from '@/lib/rate-limit/store';
import { BUSY_TIMEOUT_MS } from '@/lib/sqlite/database';
import * as contact from '@/lib/users/contact';

import { resetTables } from '../helpers/database';
import {
  delayMail,
  failNextMail,
  sentMail,
  settleDelivery,
} from '../helpers/mailbox';
import { seedOtpProof } from '../helpers/otp';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const FLOOR_MS = MINIMUM_RESPONSE_MS;
/** Timer granularity: a padded response may resolve a few ms early. */
const FLOOR_SLACK_MS = 50;
/** Above the floor, or an inline delivery would hide under it. */
const PROVIDER_DELAY_MS = 2 * FLOOR_MS;
const SAMPLES = 4;

const FLOORED_ROUTES = [
  '/api/auth/otp/send',
  '/api/auth/otp/verify',
  '/api/auth/forgot-password/send',
  '/api/auth/forgot-password/reset',
  '/api/auth/forgot-password/complete',
  '/api/auth/passwordless/send',
  '/api/auth/passwordless/verify',
];

const CAPTCHA_ROUTES = FLOORED_ROUTES.filter(
  (path) => path !== '/api/auth/forgot-password/complete'
);

const state: { realEmail: string } = { realEmail: '' };

beforeAll(async () => {
  await resetTables();
  // Every sample below must be ADMITTED: a per-IP window another file spent
  // would turn a timing assertion into a 429.
  resetSqliteStores();
  const user = await seedUser();
  state.realEmail = user.email;
});

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json', ...headers }),
      body: JSON.stringify(body),
    })
  );
}

async function timed(
  pending: () => Promise<Response>
): Promise<{ status: number; elapsed: number }> {
  const started = performance.now();
  const response = await pending();
  return { status: response.status, elapsed: performance.now() - started };
}

async function timeSend(email: string): Promise<number> {
  const { status, elapsed } = await timed(() =>
    post('/api/auth/passwordless/send', { channel: 'email', email })
  );
  expect(status).toBe(HTTP_STATUS.OK);
  return elapsed;
}

describe('the floor', () => {
  test('pads a success', async () => {
    const outcomes = await Promise.all([
      timed(() =>
        post('/api/auth/otp/send', { channel: 'email', email: state.realEmail })
      ),
      timed(() =>
        post('/api/auth/forgot-password/send', {
          channel: 'email',
          email: 'nobody-success@gmail.com',
        })
      ),
    ]);

    for (const { status, elapsed } of outcomes) {
      expect(status).toBe(HTTP_STATUS.OK);
      expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);
    }
    await settleDelivery();
  }, 30_000);

  // Neither depends on the account, and both precede the lookup, so neither
  // spends time the floor is there to hide.
  async function expectUnflooredOnEveryRoute(
    routes: readonly string[],
    send: (path: string) => Promise<Response>,
    expected: number
  ) {
    for (const path of routes) {
      const { status, elapsed } = await timed(() => send(path));
      expect(status, path).toBe(expected);
      expect(elapsed, path).toBeLessThan(FLOOR_MS / 2);
    }
  }

  test('does not pad a captcha refusal', async () => {
    await expectUnflooredOnEveryRoute(
      CAPTCHA_ROUTES,
      (path) => post(path, {}, { 'x-captcha-response': '' }),
      HTTP_STATUS.FORBIDDEN
    );
  }, 30_000);

  test('does not pad a malformed body', async () => {
    await expectUnflooredOnEveryRoute(
      FLOORED_ROUTES,
      (path) => post(path, { probe: true }),
      HTTP_STATUS.UNPROCESSABLE
    );
  }, 30_000);
});

describe('a slow provider', () => {
  test('does not push the real branch above the floor', async () => {
    delayMail(PROVIDER_DELAY_MS);

    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      unknown.push(await timeSend(`nobody-${i}@gmail.com`));
      known.push(await timeSend(state.realEmail));
    }

    for (const elapsed of [...unknown, ...known])
      expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);

    // And the real branch must not exceed it by anything like the provider's
    // delay. The margin is deliberately loose: the assertion is that the
    // provider's delay does NOT appear, not that the two arms are equal to the
    // millisecond.
    const slowest = Math.max(...known);
    expect(slowest).toBeLessThan(FLOOR_MS + PROVIDER_DELAY_MS / 2);

    // The delivery did happen — it just happened after the response.
    await settleDelivery();
  }, 120_000);
});

/** Timer granularity and scheduling noise on top of an answer held to the floor. */
const CONTENTION_SLACK_MS = 400;
/** Past the floor, so a wait on the lock cannot be mistaken for the floor. */
const HOLD_MS = FLOOR_MS + 1500;
const CONTENDED_CODE = '123456';
const CONTENDED_PASSWORD = 'Harness!Contended1';

interface Observed {
  status: number;
  elapsed: number;
  body: unknown;
  retryAfter: string | null;
}

async function observe(path: string, body: unknown): Promise<Observed> {
  const started = performance.now();
  const response = await post(path, body);
  const elapsed = performance.now() - started;
  return {
    status: response.status,
    elapsed,
    body: await response.json(),
    retryAfter: response.headers.get('retry-after'),
  };
}

/**
 * Times a verify from the account lookup, where the floor starts, not from the
 * request. `/forgot-password/reset` runs a breach check and an Argon2id hash
 * before the lookup: the same work for every identifier, but as long as the
 * machine's load makes it, so a clock started at the request measures that
 * jitter instead of the floor.
 */
function trackLookups() {
  const lookedUp = new Map<string, number>();
  const lookup = contact.activeUserWithContact;
  const spy = spyOn(contact, 'activeUserWithContact').mockImplementation(
    (channel, identifier) => {
      if (!lookedUp.has(identifier))
        lookedUp.set(identifier, performance.now());
      return lookup(channel, identifier);
    }
  );
  return {
    async observe(
      route: ContendedRoute,
      email: string
    ): Promise<Observed & { sinceLookup: number }> {
      lookedUp.delete(email);
      const observed = await observe(route.path, route.body(email));
      const looked = lookedUp.get(email);
      if (looked === undefined)
        throw new Error(`${route.path} never reached the lookup of ${email}`);
      return { ...observed, sinceLookup: performance.now() - looked };
    },
    restore: () => spy.mockRestore(),
  };
}

/** A real transaction on its own connection, holding what `acquire` took. */
function holdLock(acquire: (tx: Tx) => Promise<unknown>) {
  const acquired = Promise.withResolvers<void>();
  const finished = withTransaction(async (tx) => {
    await acquire(tx);
    acquired.resolve();
    await Bun.sleep(HOLD_MS);
  });
  finished.catch(acquired.reject);
  return { acquired: acquired.promise, finished };
}

interface ContendedRoute {
  name: string;
  path: string;
  purpose: OtpPurpose;
  seed?: SeedOptions;
  body: (email: string) => Record<string, unknown>;
}

const CONTENDED_SENDS: readonly ContendedRoute[] = [
  {
    name: 'contact verification',
    path: '/api/auth/otp/send',
    purpose: 'verify_contact',
    seed: { emailVerified: false },
    body: (email) => ({ channel: 'email', email }),
  },
  {
    name: 'password recovery',
    path: '/api/auth/forgot-password/send',
    purpose: 'forgot_password',
    body: (email) => ({ channel: 'email', email }),
  },
  {
    name: 'passwordless login',
    path: '/api/auth/passwordless/send',
    purpose: 'passwordless_login',
    body: (email) => ({ channel: 'email', email }),
  },
];

const CONTENDED_VERIFIES: readonly ContendedRoute[] = [
  {
    name: 'contact verification',
    path: '/api/auth/otp/verify',
    purpose: 'verify_contact',
    seed: { emailVerified: false },
    body: (email) => ({ channel: 'email', email, code: CONTENDED_CODE }),
  },
  {
    name: 'password recovery',
    path: '/api/auth/forgot-password/reset',
    purpose: 'forgot_password',
    body: (email) => ({
      channel: 'email',
      email,
      code: CONTENDED_CODE,
      newPassword: CONTENDED_PASSWORD,
    }),
  },
  {
    name: 'passwordless login',
    path: '/api/auth/passwordless/verify',
    purpose: 'passwordless_login',
    body: (email) => ({ channel: 'email', email, code: CONTENDED_CODE }),
  },
];

async function issuedCodes(userId: string, purpose: OtpPurpose) {
  return db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .innerJoin(
      verificationSessions,
      eq(verificationCodes.sessionId, verificationSessions.id)
    )
    .where(
      sql`${verificationSessions.userId} = ${userId} and ${verificationSessions.purpose} = ${purpose}`
    );
}

/** Polls for the issuance a send finishes after its response. */
async function awaitIssued(userId: string, purpose: OtpPurpose) {
  const deadline = performance.now() + 10_000;
  let issued = await issuedCodes(userId, purpose);
  while (issued.length === 0 && performance.now() < deadline) {
    await Bun.sleep(50);
    issued = await issuedCodes(userId, purpose);
  }
  return issued;
}

describe('PostgreSQL contention on the known branch', () => {
  // Real locks held by a separate transaction for longer than the floor: the
  // known branch has to wait on them, an unknown identifier never does.
  test.each(CONTENDED_SENDS.map((route) => [route.name, route] as const))(
    '%s send answers on the floor and still issues the code',
    async (_name, route) => {
      resetSqliteStores();
      const user = await seedUser(route.seed);
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const baseline = await observe(
          route.path,
          route.body('nobody-baseline@gmail.com')
        );

        const kind = contactKindOf('email');
        const hold = holdLock((tx) =>
          tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${user.userId}), hashtext(${kind} || ':' || ${route.purpose}))`
          )
        );
        await hold.acquired;

        const [known, unknown] = await Promise.all([
          observe(route.path, route.body(user.email)),
          observe(route.path, route.body('nobody-contended@gmail.com')),
        ]);
        expect(known.status).toBe(HTTP_STATUS.OK);
        expect(known.status).toBe(unknown.status);
        expect(known.body).toEqual(unknown.body);
        for (const { elapsed } of [known, unknown]) {
          expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);
          expect(elapsed).toBeLessThan(baseline.elapsed + CONTENTION_SLACK_MS);
        }
        // The known branch is still waiting on the lock when the answer is out.
        expect(await issuedCodes(user.userId, route.purpose)).toHaveLength(0);

        await hold.finished;
        expect(await awaitIssued(user.userId, route.purpose)).toHaveLength(1);
        await settleDelivery();
        expect(sentMail().some((mail) => mail.to === user.email)).toBe(true);
      } finally {
        logged.mockRestore();
      }
    },
    60_000
  );

  test.each(CONTENDED_VERIFIES.map((route) => [route.name, route] as const))(
    '%s verify refuses on the floor as an unknown address does, and commits nothing',
    async (_name, route) => {
      resetSqliteStores();
      const user = await seedUser(route.seed);
      const proof = await seedOtpProof({
        userId: user.userId,
        identifier: user.email,
        purpose: route.purpose,
        code: CONTENDED_CODE,
      });
      const [before] = await db
        .select({ password: accounts.password })
        .from(accounts)
        .where(credentialAccountOf(user.userId));
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      const lookups = trackLookups();
      try {
        const baseline = await lookups.observe(
          route,
          'nobody-baseline@gmail.com'
        );
        expect(baseline.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const hold = holdLock((tx) =>
          tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, user.userId))
            .for('update')
        );
        await hold.acquired;

        // The code is right: only the answer, never the work, may differ.
        const [known, unknown] = await Promise.all([
          lookups.observe(route, user.email),
          lookups.observe(route, 'nobody-contended@gmail.com'),
        ]);

        expect(known.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(known.status).toBe(unknown.status);
        expect(known.body).toEqual(unknown.body);
        expect(known.body).toMatchObject({ message: otpMsg.invalidOrExpired });
        expect(known.retryAfter).toBe(unknown.retryAfter);
        for (const { sinceLookup } of [known, unknown]) {
          expect(sinceLookup).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);
          expect(sinceLookup).toBeLessThan(
            baseline.sinceLookup + CONTENTION_SLACK_MS
          );
        }

        // Past the lock's release, where a request still running would commit.
        await hold.finished;
        await Bun.sleep(500);
        const [session] = await db
          .select({
            verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
            verifiedAt: verificationSessions.verifiedAt,
            consumedAt: verificationSessions.consumedAt,
          })
          .from(verificationSessions)
          .where(eq(verificationSessions.id, proof.sessionId));
        expect(session).toEqual({
          verifyAttemptNumber: 0,
          verifiedAt: null,
          consumedAt: null,
        });
        expect(
          await db
            .select({ id: verificationCodes.id })
            .from(verificationCodes)
            .where(eq(verificationCodes.sessionId, proof.sessionId))
        ).toHaveLength(1);
        const [after] = await db
          .select({ password: accounts.password })
          .from(accounts)
          .where(credentialAccountOf(user.userId));
        expect(after?.password).toBe(before?.password);
        const [current] = await db
          .select({ emailVerified: users.emailVerified })
          .from(users)
          .where(eq(users.id, user.userId));
        expect(current?.emailVerified).toBe(route.seed?.emailVerified ?? true);
      } finally {
        lookups.restore();
        logged.mockRestore();
      }
    },
    60_000
  );
});

describe('SQLite writer contention on the known branch', () => {
  // The global send budget is the known branch's one SQLite write. The driver is
  // synchronous, so a holder in this process could not release while the charge
  // waits: the writer lock is held from a child, released before the busy
  // timeout so the issuance succeeds, late.
  const SQLITE_HOLD_MS = BUSY_TIMEOUT_MS - 500;

  async function holdSqliteWriter(): Promise<void> {
    const child = Bun.spawn(
      [
        'bun',
        '--no-env-file',
        '-e',
        `const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(RATE_LIMIT_DB_PATH)});
db.run('BEGIN IMMEDIATE');
console.log('held');
setTimeout(() => { db.run('ROLLBACK'); db.close(); process.exit(0); }, ${SQLITE_HOLD_MS});`,
      ],
      { stdout: 'pipe', stderr: 'inherit' }
    );
    const reader = child.stdout.getReader();
    const chunk = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(chunk.value)).toContain('held');
  }

  test('known and unknown sends answer on the floor and the code is still issued', async () => {
    resetSqliteStores();
    const user = await seedUser();
    const charge = rateLimit.enforceOtpGlobalSendBudget;
    let contended = 0;
    const spy = spyOn(
      rateLimit,
      'enforceOtpGlobalSendBudget'
    ).mockImplementation(async (options) => {
      await holdSqliteWriter();
      const started = performance.now();
      try {
        await charge(options);
      } finally {
        contended = performance.now() - started;
      }
    });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const body = (email: string) => ({ channel: 'email', email });
      const path = '/api/auth/passwordless/send';
      const baseline = await observe(path, body('nobody-baseline@gmail.com'));
      const unknown = await observe(path, body('nobody-contended@gmail.com'));
      const known = await observe(path, body(user.email));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(contended).toBeGreaterThanOrEqual(SQLITE_HOLD_MS - FLOOR_SLACK_MS);
      expect(known.status).toBe(HTTP_STATUS.OK);
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
      for (const { elapsed } of [known, unknown]) {
        expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);
        expect(elapsed).toBeLessThan(baseline.elapsed + CONTENTION_SLACK_MS);
      }

      expect(await awaitIssued(user.userId, 'passwordless_login')).toHaveLength(
        1
      );
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  }, 60_000);
});

describe('a verify queued behind sends for the same user', () => {
  // A failed charge rolls back, as the busy timeout does; the sleep stands in
  // for that wait, which blocks this process's event loop and so cannot
  // overlap other requests.
  const CHARGE_HOLD_MS = 1500;
  /** For the send to queue on its lock before the verifies do. */
  const QUEUE_SETTLE_MS = 200;

  test('refuses on the floor as an unknown address does, and commits nothing', async () => {
    resetSqliteStores();
    const user = await seedUser();
    const proof = await seedOtpProof({
      userId: user.userId,
      identifier: user.email,
      purpose: 'passwordless_login',
      code: CONTENDED_CODE,
    });

    const entered = Promise.withResolvers<void>();
    let charges = 0;
    let settled = 0;
    const spy = spyOn(
      rateLimit,
      'enforceOtpGlobalSendBudget'
    ).mockImplementation(async () => {
      charges++;
      entered.resolve();
      try {
        await Bun.sleep(CHARGE_HOLD_MS);
        throw new Error('global send budget unavailable');
      } finally {
        settled++;
      }
    });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sendPath = '/api/auth/passwordless/send';
      const verifyPath = '/api/auth/passwordless/verify';
      const send = { channel: 'email', email: user.email };
      const verify = (email: string) => ({
        channel: 'email',
        email,
        code: CONTENDED_CODE,
      });
      const baseline = await observe(
        verifyPath,
        verify('nobody-baseline@gmail.com')
      );
      expect(baseline.status).toBe(HTTP_STATUS.BAD_REQUEST);

      // The first send is inside its charge, holding what a send holds; the
      // second queues behind it; the verifies queue behind both.
      const firstSend = observe(sendPath, send);
      await entered.promise;
      const secondSend = observe(sendPath, send);
      await Bun.sleep(QUEUE_SETTLE_MS);
      const [knownFirst, knownSecond, unknown] = await Promise.all([
        observe(verifyPath, verify(user.email)),
        observe(verifyPath, verify(user.email)),
        observe(verifyPath, verify('nobody-contended@gmail.com')),
      ]);

      for (const known of [knownFirst, knownSecond]) {
        expect(known.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(known.status).toBe(unknown.status);
        expect(known.body).toEqual(unknown.body);
        expect(known.body).toMatchObject({ message: otpMsg.invalidOrExpired });
        expect(known.retryAfter).toBe(unknown.retryAfter);
      }
      for (const { elapsed } of [knownFirst, knownSecond, unknown]) {
        expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);
        expect(elapsed).toBeLessThan(baseline.elapsed + CONTENTION_SLACK_MS);
      }
      const sends = await Promise.all([firstSend, secondSend]);
      for (const sent of sends) expect(sent.status).toBe(HTTP_STATUS.OK);

      const deadline = performance.now() + 10_000;
      while (settled < 2 && performance.now() < deadline) await Bun.sleep(50);
      expect(charges).toBe(2);
      expect(settled).toBe(2);

      const [session] = await db
        .select({
          attemptNumber: verificationSessions.attemptNumber,
          verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
          verifiedAt: verificationSessions.verifiedAt,
          consumedAt: verificationSessions.consumedAt,
        })
        .from(verificationSessions)
        .where(eq(verificationSessions.id, proof.sessionId));
      expect(session).toEqual({
        attemptNumber: 1,
        verifyAttemptNumber: 0,
        verifiedAt: null,
        consumedAt: null,
      });
      expect(
        await db
          .select({ id: verificationCodes.id })
          .from(verificationCodes)
          .where(eq(verificationCodes.sessionId, proof.sessionId))
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  }, 60_000);
});

/** A transaction on its own connection that keeps what `acquire` took until `release`. */
function holdUntilReleased(acquire: (tx: Tx) => Promise<unknown>) {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = withTransaction(async (tx) => {
    await acquire(tx);
    acquired.resolve();
    await release.promise;
  });
  finished.catch(acquired.reject);
  return {
    acquired: acquired.promise,
    release: release.resolve,
    finished,
    releaseAfter: (ms: number) => setTimeout(release.resolve, ms),
  };
}

function lockUserRow(userId: string) {
  return holdUntilReleased((tx) => lockUser(tx, userId));
}

/**
 * The longest a 10 ms timer ran late. A synchronous SQLite wait blocks the event
 * loop, which delays every request in the process, not only the one waiting.
 */
function watchEventLoop(): () => number {
  const tickMs = 10;
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - tickMs);
    last = now;
  }, tickMs);
  return () => {
    clearInterval(timer);
    return worst;
  };
}

/**
 * A second process takes the limiter database's writer lock `startAfterMs` from
 * now and keeps it for `holdMs`. Resolves once that process is running.
 */
async function scheduleSqliteWriter(
  startAfterMs: number,
  holdMs: number
): Promise<{ exited: Promise<number> }> {
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      '-e',
      `const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(RATE_LIMIT_DB_PATH)});
db.run('PRAGMA busy_timeout = 2000');
console.log('ready');
setTimeout(() => { db.run('BEGIN IMMEDIATE');
setTimeout(() => { db.run('ROLLBACK'); db.close(); process.exit(0); }, ${holdMs}); }, ${startAfterMs});`,
    ],
    { stdout: 'pipe', stderr: 'inherit' }
  );
  const reader = child.stdout.getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(chunk.value)).toContain('ready');
  return { exited: child.exited };
}

describe('PostgreSQL and SQLite contention together, on a real socket', () => {
  // The user's row is held past the moment the SQLite writer lock starts, so the
  // charge is reached with that lock held: the case the separate PostgreSQL and
  // SQLite tests above cannot reach.
  const POSTGRES_HOLD_MS = 1900;
  const SQLITE_START_MS = 1600;
  const SQLITE_HOLD_MS = 1500;
  /** A stall the size of the busy timeout, not scheduling noise. */
  const LOOP_STALL_LIMIT_MS = 300;

  const server = { current: null as ReturnType<typeof Bun.serve> | null };
  function origin(): string {
    const port = server.current?.port;
    if (port === undefined) throw new Error('harness server did not bind');
    return `http://127.0.0.1:${port}`;
  }

  beforeAll(() => {
    server.current = Bun.serve({ port: 0, fetch: app.fetch });
  });
  afterAll(() => void server.current?.stop(true));

  async function observeOnSocket(
    path: string,
    body: unknown
  ): Promise<Observed> {
    const started = performance.now();
    const response = await fetch(`${origin()}${path}`, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json();
    return {
      status: response.status,
      elapsed: performance.now() - started,
      body: parsed,
      retryAfter: response.headers.get('retry-after'),
    };
  }

  test.each(CONTENDED_SENDS.map((route) => [route.name, route] as const))(
    '%s send answers on the floor, keeps the event loop free and still issues',
    async (_name, route) => {
      resetSqliteStores();
      const user = await seedUser(route.seed);
      getRateLimitStore();
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const contended = async (email: string, issues: boolean) => {
          const hold = lockUserRow(user.userId);
          await hold.acquired;
          const writer = await scheduleSqliteWriter(
            SQLITE_START_MS,
            SQLITE_HOLD_MS
          );
          const stopWatching = watchEventLoop();
          hold.releaseAfter(POSTGRES_HOLD_MS);
          const observed = await observeOnSocket(route.path, route.body(email));
          await Promise.all([hold.finished, writer.exited]);
          if (issues)
            expect(await awaitIssued(user.userId, route.purpose)).toHaveLength(
              1
            );
          await settleDelivery();
          return { ...observed, stalledMs: stopWatching() };
        };

        const unknown = await contended('nobody-combined@gmail.com', false);
        const known = await contended(user.email, true);

        expect(known.status).toBe(HTTP_STATUS.OK);
        expect(known.status).toBe(unknown.status);
        expect(known.body).toEqual(unknown.body);
        for (const { elapsed, stalledMs } of [known, unknown]) {
          expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - FLOOR_SLACK_MS);
          expect(elapsed).toBeLessThan(FLOOR_MS + CONTENTION_SLACK_MS);
          expect(stalledMs).toBeLessThan(LOOP_STALL_LIMIT_MS);
        }
        expect(Math.abs(known.elapsed - unknown.elapsed)).toBeLessThan(
          CONTENTION_SLACK_MS / 2
        );
      } finally {
        logged.mockRestore();
      }
    },
    60_000
  );
});

async function spentProof(
  owner: { userId: string; email: string },
  purpose: OtpPurpose
): Promise<string> {
  const [row] = await db
    .insert(verificationSessions)
    .values({
      userId: owner.userId,
      channel: 'email',
      identifier: owner.email,
      purpose,
      verifiedAt: new Date(),
      consumedAt: new Date(),
    })
    .returning({ id: verificationSessions.id });
  if (!row) throw new Error('spentProof inserted no session');
  return row.id;
}

describe('a verify against other writers of its proof rows', () => {
  /** After the first statement could have started, before the deadline. */
  const USER_RELEASE_MS = 1800;
  /** Past the deadline, so a wait on the row cannot end by itself. */
  const PROOF_RELEASE_MS = FLOOR_MS + 2000;

  test.each(CONTENDED_VERIFIES.map((route) => [route.name, route] as const))(
    '%s verify answers on the floor with a retention sweep running, which waits on no held row',
    async (_name, route) => {
      resetSqliteStores();
      const user = await seedUser(route.seed);
      const other = await seedUser();
      const mine = await spentProof(user, route.purpose);
      const theirs = await spentProof(other, 'passwordless_login');
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      const lookups = trackLookups();
      try {
        const baseline = await lookups.observe(
          route,
          'nobody-baseline@gmail.com'
        );
        expect(baseline.status).toBe(HTTP_STATUS.BAD_REQUEST);

        // Writers in the canonical order: the user first, a proof row after.
        const userHold = lockUserRow(user.userId);
        const otherHold = holdUntilReleased(async (tx) => {
          await lockUser(tx, other.userId);
          await tx
            .select({ id: verificationSessions.id })
            .from(verificationSessions)
            .where(eq(verificationSessions.id, theirs))
            .for('update');
        });
        await Promise.all([userHold.acquired, otherHold.acquired]);
        const timers = [
          userHold.releaseAfter(USER_RELEASE_MS),
          otherHold.releaseAfter(PROOF_RELEASE_MS),
        ];

        let sweepDone = false;
        const sweep = runDatabaseSweep().finally(() => {
          sweepDone = true;
        });
        // For the sweep to reach whatever it would hold.
        await Bun.sleep(300);

        try {
          const [known, unknown] = await Promise.all([
            lookups.observe(route, user.email),
            lookups.observe(route, 'nobody-contended@gmail.com'),
          ]);

          expect(known.status).toBe(HTTP_STATUS.BAD_REQUEST);
          expect(known.status).toBe(unknown.status);
          expect(known.body).toEqual(unknown.body);
          expect(known.body).toMatchObject({
            message: otpMsg.invalidOrExpired,
          });
          expect(known.retryAfter).toBe(unknown.retryAfter);
          for (const { sinceLookup } of [known, unknown]) {
            expect(sinceLookup).toBeGreaterThanOrEqual(
              FLOOR_MS - FLOOR_SLACK_MS
            );
            expect(sinceLookup).toBeLessThan(
              baseline.sinceLookup + CONTENTION_SLACK_MS
            );
          }
          // Both owners are still locked here: the sweep left their proofs for
          // its next run instead of queueing on them.
          expect(sweepDone).toBe(true);
        } finally {
          for (const timer of timers) clearTimeout(timer);
          userHold.release();
          otherHold.release();
          await Promise.allSettled([
            userHold.finished,
            otherHold.finished,
            sweep,
          ]);
        }

        const proofs = () =>
          db
            .select({ id: verificationSessions.id })
            .from(verificationSessions)
            .where(
              sql`${verificationSessions.id} in (${mine}::uuid, ${theirs}::uuid)`
            );
        expect(await proofs()).toHaveLength(2);

        await runDatabaseSweep();
        expect(await proofs()).toHaveLength(0);
      } finally {
        lookups.restore();
        logged.mockRestore();
      }
    },
    60_000
  );

  test.each(CONTENDED_VERIFIES.map((route) => [route.name, route] as const))(
    '%s verify gives up on a proof row held out of lock order at the deadline, not a statement later',
    async (_name, route) => {
      resetSqliteStores();
      const user = await seedUser(route.seed);
      const proof = await seedOtpProof({
        userId: user.userId,
        identifier: user.email,
        purpose: route.purpose,
        code: CONTENDED_CODE,
      });
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      const lookups = trackLookups();
      try {
        const baseline = await lookups.observe(
          route,
          'nobody-baseline@gmail.com'
        );
        expect(baseline.status).toBe(HTTP_STATUS.BAD_REQUEST);

        // The user's row is released with the deadline still ahead, so the next
        // statement is the one that has to be cut: a timeout set once would give
        // it the whole budget again.
        const userHold = lockUserRow(user.userId);
        const proofHold = holdUntilReleased((tx) =>
          tx
            .select({ id: verificationSessions.id })
            .from(verificationSessions)
            .where(eq(verificationSessions.id, proof.sessionId))
            .for('update')
        );
        await Promise.all([userHold.acquired, proofHold.acquired]);
        const timers = [
          userHold.releaseAfter(USER_RELEASE_MS),
          proofHold.releaseAfter(PROOF_RELEASE_MS),
        ];

        try {
          const [known, unknown] = await Promise.all([
            lookups.observe(route, user.email),
            lookups.observe(route, 'nobody-contended@gmail.com'),
          ]);

          expect(known.status).toBe(HTTP_STATUS.BAD_REQUEST);
          expect(known.status).toBe(unknown.status);
          expect(known.body).toEqual(unknown.body);
          expect(known.retryAfter).toBe(unknown.retryAfter);
          for (const { sinceLookup } of [known, unknown]) {
            expect(sinceLookup).toBeGreaterThanOrEqual(
              FLOOR_MS - FLOOR_SLACK_MS
            );
            expect(sinceLookup).toBeLessThan(
              baseline.sinceLookup + CONTENTION_SLACK_MS
            );
          }
        } finally {
          for (const timer of timers) clearTimeout(timer);
          userHold.release();
          proofHold.release();
          await Promise.allSettled([userHold.finished, proofHold.finished]);
        }

        await Bun.sleep(300);
        const [session] = await db
          .select({
            verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
            verifiedAt: verificationSessions.verifiedAt,
            consumedAt: verificationSessions.consumedAt,
          })
          .from(verificationSessions)
          .where(eq(verificationSessions.id, proof.sessionId));
        expect(session).toEqual({
          verifyAttemptNumber: 0,
          verifiedAt: null,
          consumedAt: null,
        });
      } finally {
        lookups.restore();
        logged.mockRestore();
      }
    },
    60_000
  );
});

describe('a transaction deadline is absolute', () => {
  const BUDGET_MS = 1500;
  /** Rollback and the error's journey, on top of the budget. */
  const SETTLE_MS = 400;

  async function failedAttempts(userId: string): Promise<number | undefined> {
    const [row] = await db
      .select({ failed: users.failedLoginAttempts })
      .from(users)
      .where(eq(users.id, userId));
    return row?.failed;
  }

  test('two statements that each fit the budget do not fit it together, and neither commits', async () => {
    const user = await seedUser();
    const started = performance.now();
    const attempt = withTransaction(
      async (tx) => {
        await tx
          .update(users)
          .set({ failedLoginAttempts: 7 })
          .where(eq(users.id, user.userId));
        await tx.execute(sql`select pg_sleep(1)`);
        await tx.execute(sql`select pg_sleep(1)`);
      },
      undefined,
      Date.now() + BUDGET_MS
    );

    await expect(attempt).rejects.toBeInstanceOf(TransactionDeadlineError);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS + SETTLE_MS);
    expect(await failedAttempts(user.userId)).toBe(0);
  }, 20_000);

  test('a later lock wait is cut at the same deadline', async () => {
    const user = await seedUser();
    const hold = lockUserRow(user.userId);
    await hold.acquired;
    try {
      const started = performance.now();
      const attempt = withTransaction(
        async (tx) => {
          await tx.execute(sql`select pg_sleep(0.5)`);
          await lockUser(tx, user.userId);
        },
        undefined,
        Date.now() + BUDGET_MS
      );

      await expect(attempt).rejects.toBeInstanceOf(TransactionDeadlineError);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS + SETTLE_MS);
    } finally {
      hold.release();
      await hold.finished;
    }
  }, 20_000);

  test('statements of a nested transaction are cut at the same deadline, at any depth', async () => {
    const user = await seedUser();
    const started = performance.now();
    const attempt = withTransaction(
      async (tx) => {
        await tx
          .update(users)
          .set({ failedLoginAttempts: 7 })
          .where(eq(users.id, user.userId));
        await tx.transaction(async (inner) => {
          await inner.execute(sql`select pg_sleep(1)`);
          await inner.transaction(async (innermost) => {
            await innermost.execute(sql`select pg_sleep(1)`);
          });
        });
      },
      undefined,
      Date.now() + BUDGET_MS
    );

    await expect(attempt).rejects.toBeInstanceOf(TransactionDeadlineError);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS + SETTLE_MS);
    expect(await failedAttempts(user.userId)).toBe(0);
  }, 20_000);

  test('a lock wait inside a nested transaction is cut at the deadline', async () => {
    const user = await seedUser();
    const hold = lockUserRow(user.userId);
    await hold.acquired;
    try {
      const started = performance.now();
      const attempt = withTransaction(
        async (tx) => {
          await tx.execute(sql`select pg_sleep(0.5)`);
          await tx.transaction((inner) => lockUser(inner, user.userId));
        },
        undefined,
        Date.now() + BUDGET_MS
      );

      await expect(attempt).rejects.toBeInstanceOf(TransactionDeadlineError);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS + SETTLE_MS);
    } finally {
      hold.release();
      await hold.finished;
    }
  }, 20_000);

  test('a body that survives a cut statement in a nested transaction cannot run another', async () => {
    let afterwards = false;
    const started = performance.now();
    const attempt = withTransaction(
      async (tx) => {
        try {
          await tx.transaction((inner) =>
            inner.execute(sql`select pg_sleep(3)`)
          );
        } catch {
          // the body survives the cut statement
        }
        afterwards = true;
        await tx.execute(sql`select 1`);
      },
      undefined,
      Date.now() + BUDGET_MS
    );

    await expect(attempt).rejects.toBeInstanceOf(TransactionDeadlineError);
    expect(afterwards).toBe(true);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS + SETTLE_MS);
  }, 20_000);

  test('the query builders and the relational API are cut at the deadline', async () => {
    const user = await seedUser();
    const hold = lockUserRow(user.userId);
    await hold.acquired;
    try {
      const attempts = [
        (tx: Tx) =>
          tx.select({ slept: sql`pg_sleep(1)` }).from(sql`(select 1) as one`),
        (tx: Tx) =>
          tx.query.users.findFirst({
            where: sql`(select pg_sleep(1)) is not null`,
          }),
        (tx: Tx) =>
          tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, user.userId))
            .for('update'),
      ];
      for (const statement of attempts) {
        const started = performance.now();
        await expect(
          withTransaction(
            async (tx) => {
              await tx.execute(sql`select pg_sleep(0.8)`);
              await statement(tx);
            },
            undefined,
            Date.now() + 1200
          )
        ).rejects.toBeInstanceOf(TransactionDeadlineError);
        expect(performance.now() - started).toBeLessThan(1200 + SETTLE_MS);
      }
    } finally {
      hold.release();
      await hold.finished;
    }
  }, 20_000);

  test('a deadline already behind it runs nothing', async () => {
    let ran = false;
    await expect(
      withTransaction(
        async (tx) => {
          ran = true;
          await tx.execute(sql`select 1`);
        },
        undefined,
        Date.now() - 1
      )
    ).rejects.toBeInstanceOf(TransactionDeadlineError);
    expect(ran).toBe(false);
  });

  test('within the budget it commits, and the limit does not outlive the transaction', async () => {
    const user = await seedUser();
    await withTransaction(
      async (tx) => {
        await tx
          .update(users)
          .set({ failedLoginAttempts: 3 })
          .where(eq(users.id, user.userId));
        await tx.execute(sql`select pg_sleep(0.2)`);
        await tx.execute(sql`select pg_sleep(0.2)`);
      },
      undefined,
      Date.now() + BUDGET_MS
    );
    expect(await failedAttempts(user.userId)).toBe(3);

    const [setting] = await withTransaction((tx) =>
      tx.execute<{ statement_timeout: string }>(sql`show statement_timeout`)
    );
    expect(setting?.statement_timeout).toBe('0');
  }, 20_000);
});

describe('a refund of a failed delivery', () => {
  test('queues on the user before it holds the code row', async () => {
    resetSqliteStores();
    const user = await seedUser({ emailVerified: false });
    failNextMail(new Error('provider down'));

    const captured: { task?: () => Promise<void> } = {};
    await processOtpSend({
      userId: user.userId,
      identifier: user.email,
      channel: 'email',
      purpose: 'verify_contact',
      sendTo: user.email,
      entityName: CONTACT_LABEL.email,
      deferDelivery: (task) => {
        captured.task = task;
      },
    });
    const [session] = await db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, user.userId),
          eq(verificationSessions.purpose, 'verify_contact')
        )
      );
    const delivery = captured.task;
    if (!session || !delivery)
      throw new Error('the send left nothing to refund');

    // A send mid-transaction: the user and its session row, as it takes them.
    const hold = holdUntilReleased(async (tx) => {
      await lockUser(tx, user.userId);
      await tx
        .select({ id: verificationSessions.id })
        .from(verificationSessions)
        .where(eq(verificationSessions.userId, user.userId))
        .for('update');
    });
    await hold.acquired;
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const refunding = delivery().catch((error: unknown) => error);
      await Bun.sleep(300);

      // What a verify needs after its own locks: the code row, free to take.
      await withTransaction((tx) =>
        tx.execute(
          sql`select id from verification_codes where session_id = ${session.id}::uuid for update nowait`
        )
      );

      hold.release();
      await hold.finished;
      await refunding;
      expect(
        await db
          .select({ id: verificationCodes.id })
          .from(verificationCodes)
          .where(eq(verificationCodes.sessionId, session.id))
      ).toHaveLength(0);
    } finally {
      hold.release();
      logged.mockRestore();
    }
  }, 20_000);
});
