/**
 * Boot smoke test.
 *
 * A Bun server has no build artefact, so nothing else evaluates the module
 * graph before deploy: `lib/env.server.ts` throws at load on missing
 * configuration, `lib/auth/index.ts` constructs Better Auth at load, and the
 * SQLite stores open on first use. Without this, the first production request
 * would discover a broken import, a missing variable or an unmounted volume.
 *
 * What it proves: the process starts, the bindings register, every SQLite
 * readiness check passes (so the volume opened, migrated, and reported the
 * PRAGMAs this build expects), the security headers are attached, an unrouted
 * path produces the API envelope rather than a framework default, Better Auth is
 * mounted, and every authenticated surface refuses an anonymous caller.
 *
 * What it does NOT prove: that PostgreSQL is reachable. CI runs this against a
 * deliberately unreachable host, so the SQLite checks are asserted one by one
 * and the aggregate `status` only has to be CONSISTENT with `checks`.
 */
import * as z from 'zod';

// Not `@/lib/audit`: that one loads `db/schema` and the OTP config into this
// parent process for one constant.
import { TRUSTED_IP_HEADERS } from '@/lib/http/client-ip';
import { SECURITY_HEADERS } from '@/lib/http/security-headers';

/**
 * Validated because a coerced port (`Number('')` is 0, a typo is NaN) makes the
 * child bind a random one while every probe goes to the requested port, which
 * reads as "server did not boot".
 */
function smokePort(): number {
  const configured = process.env.SMOKE_PORT;
  if (configured === undefined || configured === '') return 3999;
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(
      `SMOKE_PORT must be an integer between 1 and 65535. Received: "${configured}".`
    );
  return port;
}

const PORT = smokePort();
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/**
 * The trusted edge header every real request carries. Without it
 * `ipIdentifier` fails CLOSED in production, so every `preAuth: 'ip-limit'`
 * route would answer 503 before the boundary a check aims at.
 */
const EDGE_HEADERS: Record<string, string> = {
  [TRUSTED_IP_HEADERS[0]]: '203.0.113.7',
};

/**
 * The maintenance token this run uses and gives the child; readiness answers
 * 401 without it. The ambient value when set, otherwise a throwaway, and at
 * least 32 characters either way because `lib/env.server.ts` refuses shorter.
 */
const MAINTENANCE_TOKEN =
  process.env.SQLITE_MAINTENANCE_TOKEN ||
  `smoke-${crypto.randomUUID()}${crypto.randomUUID()}`;

const probe = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...EDGE_HEADERS, ...init.headers },
  });

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** The DEPLOYED command, flag for flag; keep it in step with `package.json`'s `start`. */
const SERVER_COMMAND = ['bun', '--bun', 'server.ts'] as const;

const server = Bun.spawn([...SERVER_COMMAND], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SQLITE_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN,
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

/**
 * A signal to this process must reach the CHILD, or an interrupted run leaves a
 * server holding the port for the next run to probe.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.kill(signal);
    process.exitCode = 1;
  });

/** Polls readiness until the server answers, dies, or the deadline passes. */
async function waitForBoot(): Promise<Response | null> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return null;
    try {
      return await probe('/api/health/storage', {
        headers: { 'x-maintenance-token': MAINTENANCE_TOKEN },
      });
    } catch {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
  return null;
}

const healthBodySchema = z.object({
  status: z.string().optional(),
  checks: z.record(z.string(), z.boolean()).optional(),
});

const envelopeSchema = z.object({ success: z.boolean() });

async function runChecks(health: Response): Promise<Check[]> {
  const healthRaw: unknown = await health.json();
  const healthParsed = healthBodySchema.safeParse(healthRaw);
  const healthBody = healthParsed.success ? healthParsed.data : {};
  const checks = healthBody.checks ?? {};
  // Everything except `postgres`, which this environment may deliberately lack.
  const storageChecks = Object.entries(checks).filter(
    ([name]) => name !== 'postgres'
  );
  const failedStorage = storageChecks
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const storageSummary =
    storageChecks.length === 0
      ? 'readiness reported no checks at all'
      : `${storageChecks.length} checked, failed=[${failedStorage.join(', ')}]`;
  const expectedStatus = Object.values(checks).every(Boolean)
    ? 'ok'
    : 'degraded';
  const missing = await probe('/api/definitely-not-a-route');
  const missingRaw: unknown = await missing.json();
  const missingBody = envelopeSchema.safeParse(missingRaw);
  // Rejected by Better Auth's own path allowlist, so 404 is the expected
  // answer. A 500 or a connection error is the failure this catches.
  const authProbe = await probe('/api/auth/not-an-endpoint');
  // The `/api/internal/*` prefix must be unrouted, not merely guarded.
  const internal = await probe('/api/internal/sqlite-sweep', {
    method: 'POST',
  });
  // Readiness WITHOUT the token: a caller outside the container gets nothing.
  const anonymousHealth = await probe('/api/health/storage');
  // A gate a browser reaches WITHOUT a preflight (multipart is a CORS-simple
  // content type). A real form is sent so that a 400, meaning the
  // body was parsed before authentication, is told apart from the 401.
  const uploadForm = new FormData();
  uploadForm.append(
    'files',
    new File(['x'], 'probe.png', { type: 'image/png' })
  );
  const upload = await probe('/api/upload/file?resource=users', {
    method: 'POST',
    body: uploadForm,
  });
  // The access boundary only; the document itself is `tests/unit/openapi-document.test.ts`.
  // The document maps the whole attack surface.
  const contract = await probe('/openapi.json');
  const contractText = await contract.text();

  const wrongHeaders = Object.entries(SECURITY_HEADERS)
    .filter(([name, expected]) => health.headers.get(name) !== expected)
    .map(
      ([name, expected]) =>
        `${name}=${health.headers.get(name)} want ${expected}`
    );

  return [
    {
      name: 'every storage readiness check passes',
      ok: storageChecks.length > 0 && failedStorage.length === 0,
      detail: healthParsed.success
        ? storageSummary
        : `readiness body has an unexpected shape: ${JSON.stringify(healthRaw)}`,
    },
    {
      name: 'readiness status agrees with its own checks',
      ok:
        healthBody.status === expectedStatus &&
        health.status === (expectedStatus === 'ok' ? 200 : 503),
      detail: `HTTP ${health.status} status=${healthBody.status} expected=${expectedStatus} postgres=${String(checks.postgres)}`,
    },
    {
      // By VALUE against the production constant: a weakened CSP is likelier
      // than a deleted one. The child inherits this environment, so whether
      // HSTS is in the set agrees with the constant here.
      name: 'security headers present, with their exact values',
      ok: wrongHeaders.length === 0,
      detail:
        wrongHeaders.length === 0
          ? `all ${Object.keys(SECURITY_HEADERS).length} headers match`
          : wrongHeaders.join('; '),
    },
    {
      name: 'unknown route returns the API envelope',
      ok:
        missing.status === 404 &&
        missingBody.success &&
        !missingBody.data.success,
      detail: `HTTP ${missing.status} ${missing.headers.get('content-type') ?? 'no content-type'} envelope=${String(missingBody.success)}`,
    },
    {
      name: 'better auth handler is mounted',
      ok: authProbe.status < 500,
      detail: `HTTP ${authProbe.status}`,
    },
    {
      name: 'no /api/internal route is served',
      ok: internal.status === 404,
      detail: `HTTP ${internal.status}`,
    },
    {
      name: 'file upload rejects an unauthenticated request',
      ok: upload.status === 401,
      detail: `HTTP ${upload.status}`,
    },
    {
      name: 'storage readiness is not served to an anonymous caller',
      ok: anonymousHealth.status === 401,
      detail: `HTTP ${anonymousHealth.status}`,
    },
    {
      name: 'the OpenAPI contract is not served to an anonymous caller',
      // 401, and no path names in the body whatever the status was.
      ok: contract.status === 401 && !contractText.includes('"paths"'),
      detail: `HTTP ${contract.status} bodyLen=${contractText.length}`,
    },
  ];
}

async function main(): Promise<Check[]> {
  const health = await waitForBoot();
  if (health)
    return [
      { name: 'server boots', ok: true, detail: BASE },
      ...(await runChecks(health)),
    ];

  return [
    {
      name: 'server boots',
      ok: false,
      detail:
        server.exitCode === null
          ? `no response within ${BOOT_TIMEOUT_MS}ms`
          : `process exited ${server.exitCode}`,
    },
  ];
}

const checks = await main().catch((error: unknown) => [
  {
    name: 'smoke run completed',
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  },
]);

server.kill();
await server.exited;

for (const check of checks)
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);

const failed = checks.filter((check) => !check.ok).length;
console.log(
  failed === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failed} failed`
);

// `exitCode`, not `process.exit()`: the spawned server has already been killed
// above and stdout must flush before the process ends.
process.exitCode = failed === 0 ? 0 : 1;
