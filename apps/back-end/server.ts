/* eslint-disable unicorn/no-process-exit -- this IS the process entry point: a
   rejected runtime must exit non-zero before anything serves, and a completed
   shutdown must end the process rather than throw into nothing. */
/**
 * Entry point: validate the runtime, then start the app.
 *
 * ⚠️ Static imports here are leaves only (`utils/log`, `lib/startup`,
 * `package.json`): imports are evaluated before this file's code, so importing
 * the application statically would let `lib/env.server.ts` decide whether this
 * is production before `NODE_ENV` is validated. The application is loaded by
 * dynamic import, below the checks.
 */
import { version as bunVersion } from 'bun';
import { Database } from 'bun:sqlite';

import { errorClassOf, logLine } from '@/utils/log';

import {
  bunVersionVerdict,
  MIN_SQLITE_VERSION,
  nodeEnvVerdict,
  portVerdict,
  sqliteVersionVerdict,
} from './lib/startup';
import packageManifest from './package.json';

function fail(message: string): never {
  logLine('error', { msg: 'startup rejected', reason: message });
  process.exit(1);
}

function requireNodeEnv(): string {
  const verdict = nodeEnvVerdict(process.env.NODE_ENV);
  if (!verdict.ok) fail(verdict.reason);
  return verdict.nodeEnv;
}

function requirePort(): number {
  const verdict = portVerdict(process.env.PORT);
  if (!verdict.ok) fail(verdict.reason);
  return verdict.port;
}

function assertBunVersion(): void {
  const verdict = bunVersionVerdict(bunVersion, packageManifest.packageManager);
  if (!verdict.ok) fail(verdict.reason);
  if (verdict.warning) console.warn(verdict.warning);
}

function assertSqliteVersion(): void {
  const db = new Database(':memory:');
  let version: string;
  try {
    const statement = db.prepare<{ v: string }, []>(
      'SELECT sqlite_version() AS v'
    );
    version = statement.get()?.v ?? '';
    statement.finalize();
  } finally {
    db.close(true);
  }

  const verdict = sqliteVersionVerdict(version, MIN_SQLITE_VERSION);
  if (!verdict.ok) fail(verdict.reason);
}

const nodeEnv = requireNodeEnv();
const port = requirePort();
assertBunVersion();
assertSqliteVersion();

// Only now. Everything below this line reads a validated NODE_ENV.
const { app, MAX_ROUTE_TIMEOUT_SECONDS } = await import('./app');
const { MAX_REQUEST_BODY_BYTES } = await import('./lib/http/request');
const { drainAfterResponse, pendingAfterResponse } =
  await import('./lib/http/after-response');
const { closeRateLimitStore } = await import('./lib/rate-limit/store');
const { closeCacheStore } = await import('./lib/cache');
const { closeDatabase } = await import('./db');
const { startSchedule } = await import('./lib/maintenance/schedule');
const { acquireWriterLock } = await import('./lib/sqlite/writer-lock');
const { SQLITE_DIR } = await import('./lib/env.server');
const {
  createShutdown,
  SHUTDOWN_POLICY,
  shutdownTimeoutMs,
  stopServerGracefully,
} = await import('./lib/shutdown');

// Claimed BEFORE `startSchedule`: this lock is what elects the single owner of
// the per-process scheduled sweeps.
const writerLock = acquireWriterLock(SQLITE_DIR);

const IDLE_TIMEOUT_SECONDS = 60;

/** The orchestrator's stop grace period must exceed this value. */
const SHUTDOWN_TIMEOUT_MS = shutdownTimeoutMs({
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  maxRouteTimeoutSeconds: MAX_ROUTE_TIMEOUT_SECONDS,
});

const stopServer = (budgetMs: number) =>
  stopServerGracefully({
    budgetMs,
    stop: (closeActiveConnections) => app.stop(closeActiveConnections),
    pendingRequests: () => app.server?.pendingRequests ?? 0,
    error: (line) => logLine('error', line),
  });

app.listen({ port, idleTimeout: IDLE_TIMEOUT_SECONDS }, (server) => {
  logLine('log', {
    msg: 'server started',
    // Report the bound port because the kernel may choose it.
    port: server.port,
    hostname: server.hostname,
    env: nodeEnv,
    bun: bunVersion,
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    maxRouteTimeoutSeconds: MAX_ROUTE_TIMEOUT_SECONDS,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    // The effective shutdown timing, for the deployment's stop grace period.
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    gracefulStopMs: SHUTDOWN_POLICY.gracefulStopMs,
  });
});

const schedule = startSchedule();

const shutdown = createShutdown(
  {
    stopServer,
    stopSweeps: schedule.stopAndDrain,
    drainAfterResponse,
    pendingAfterResponse,
    closeStores,
    exit: (code) => process.exit(code),
    log: (line) => logLine('log', line),
    error: (line) => logLine('error', line),
  },
  { shutdownMs: SHUTDOWN_TIMEOUT_MS }
);

const closeState = { done: false };
// One store's failure must not strand the others, but it must not be reported as
// a clean stop either: every close is attempted, then the failures are raised
// together for the coordinator's exit code.
async function closeStores(): Promise<void> {
  if (closeState.done) return;
  closeState.done = true;
  const failures = [
    await closeStore('postgres', closeDatabase),
    await closeStore('rate-limit', closeRateLimitStore),
    await closeStore('cache', closeCacheStore),
    // Keep ownership until every protected store has closed.
    await closeStore('writer-lock', writerLock.release),
  ].filter((failure) => failure !== null);

  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `stores left open: ${failures.map((failure) => failure.store).join(', ')}`
    );
}

async function closeStore(
  name: string,
  close: () => void | Promise<void>
): Promise<{ store: string; error: unknown } | null> {
  try {
    await close();
    return null;
  } catch (error) {
    logLine('error', {
      msg: 'store close failed',
      store: name,
      errorClass: errorClassOf(error),
    });
    return { store: name, error };
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void shutdown(signal);
  });

// Both sync and async escaped faults must use the store-draining shutdown path.
for (const event of ['unhandledRejection', 'uncaughtException'] as const)
  process.on(event, (error: unknown) => {
    logLine('error', {
      msg: 'unhandled fault',
      event,
      errorClass: errorClassOf(error),
    });
    void shutdown(event, 1);
  });
