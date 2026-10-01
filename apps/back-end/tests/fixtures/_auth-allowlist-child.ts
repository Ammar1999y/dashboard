/**
 * Subprocess body for `auth-allowlist-feature-gates.test.ts`: the allowlist is
 * derived at module load, so each feature configuration needs its own process.
 * Prints ONE line of JSON on stdout.
 */
import {
  BETTER_AUTH_ALLOWED_PATH_SET,
  BETTER_AUTH_KNOWN_PATHS,
  BETTER_AUTH_ROUTE_PREFIX,
} from '@/lib/auth/allowed-paths';

const path = process.argv[2] ?? '';

console.log(
  JSON.stringify({
    allowed: BETTER_AUTH_ALLOWED_PATH_SET.has(path),
    known: BETTER_AUTH_KNOWN_PATHS.has(path),
    routed: BETTER_AUTH_ROUTE_PREFIX.paths.some((entry) => entry.path === path),
  })
);
