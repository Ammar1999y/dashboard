/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun scripts/healthcheck.ts`: the container health check. Exits 0 only when
 * readiness answers 2xx to the maintenance token.
 *
 * A script rather than a `curl` line because Coolify refuses a health-check
 * command containing `"`, `$` or `|`, then falls back to an HTTP check that
 * sends no token, which this route answers 401 forever
 * (`reports/coolify-deployment.md` §7).
 *
 * ⚠️ No application import beyond the contract and `lib/startup`: `lib/env.server`
 * validates and logs at load, which would run on every poll.
 */
import { getStorageHealth } from '@app/shared/api/health';
import { MAINTENANCE_TOKEN_HEADER } from '@app/shared/validation/health';

import { portVerdict } from '@/lib/startup';

// Under the check's 5 s timeout, so a hung server fails here with a reason
// rather than being killed with none.
const TIMEOUT_MS = 4000;

function fail(reason: string): never {
  console.error(`health check failed: ${reason}`);
  process.exit(1);
}

const port = portVerdict(process.env.PORT);
if (!port.ok) fail(port.reason);
const token = process.env.SQLITE_MAINTENANCE_TOKEN;
if (!token) fail('SQLITE_MAINTENANCE_TOKEN is not set');

try {
  const response = await fetch(
    `http://127.0.0.1:${port.port}${getStorageHealth.path}`,
    {
      headers: { [MAINTENANCE_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!response.ok) fail(`readiness answered ${response.status}`);
} catch (error) {
  fail(error instanceof Error ? error.name : String(error));
}
