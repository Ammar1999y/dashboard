/**
 * Every success a binding answers, held to its published contract
 * (`endpointIssues`); its status is the entry's by construction. Its refusals
 * are held to the statuses and codes the entry publishes in `run.ts`. The Better
 * Auth prefix route holds this project's own plugin endpoints to their
 * entries the same way, and a two-factor challenge from any
 * path to the challenge schema. Under the test runner a mismatch
 * answers 500 and fails the test that caused it; in development it is only
 * logged, because the write behind the answer has already committed and a 500
 * would invite a duplicate retry. Production never runs it.
 *
 * At the Better Auth prefix the library's own answers and every refusal pass
 * untouched; the database tiers hold those, with everything else, to the
 * generated document (`tests/helpers/document-check.ts`).
 */
import type { AnyBinding } from './binding';
import type { ResponseIssue } from '@app/shared/api/issues';

import { PLUGIN_ENDPOINTS } from '@app/shared/api/all';
import {
  endpointIssues,
  twoFactorChallengeIssues,
} from '@app/shared/api/issues';
import { HTTP_STATUS } from '@app/shared/http-status';

import { logLine } from '@/utils/log';

import { REDIRECTING_PLUGIN_PATHS } from './openapi/better-auth-tables';
import { invalidResponse, toWebResponse } from './response';
import {
  challengeCoverageId,
  pluginCoverageId,
  pluginCoverageName,
  recordResponseCoverage,
  redirectCoverageId,
  responseCoverageId,
} from './response-coverage';
import { recordResponseMismatch } from './response-mismatches';

export type ResponseCheckMode = 'enforce' | 'log';

/** `null` in production, where `RESPONSE_CONTRACT_CHECK` is ignored. */
export function responseCheckMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): ResponseCheckMode | null {
  if (env.NODE_ENV === 'production') return null;
  const configured = env.RESPONSE_CONTRACT_CHECK?.trim();
  if (!configured) return 'log';
  if (configured === 'enforce') return 'enforce';
  throw new Error(
    `RESPONSE_CONTRACT_CHECK must be "enforce" or unset; got "${configured}"`
  );
}

/** Paths and codes, never the values that failed. */
export const described = (issues: readonly ResponseIssue[]): string[] =>
  issues.map(
    ({ path, code }) => `${path.map(String).join('.') || 'body'}: ${code}`
  );

/**
 * The answer when `problems` is not empty: logged in both modes, and under the
 * runner recorded and replaced by a 500.
 */
export function refused<T>(
  mode: ResponseCheckMode,
  route: string,
  problems: readonly string[],
  answer: T,
  replacement: () => T
): T {
  logLine('error', { msg: 'response.contract.mismatch', route, problems });
  if (mode === 'log') return answer;
  recordResponseMismatch(`${route}: ${problems.join('; ')}`);
  return replacement();
}

/**
 * One success answer held to the contract of `binding`'s entry: true when it
 * may go out.
 * A pass counts towards the coverage gate; a mismatch is logged and, under the
 * runner, recorded and answered 500.
 *
 * `body` as the handler built it, never its JSON: the response schema Elysia
 * compiles judges that same value, and the two must agree on a `Date`.
 */
export function checkSuccess(
  mode: ResponseCheckMode,
  { entry, key }: Pick<AnyBinding, 'entry' | 'key'>,
  body: unknown
): boolean {
  const problems = described(endpointIssues(entry, body));
  if (problems.length === 0) {
    recordResponseCoverage(responseCoverageId(entry, body));
    return true;
  }
  return refused(mode, key, problems, true, () => false);
}

const REDIRECTING: ReadonlySet<string> = new Set(REDIRECTING_PLUGIN_PATHS);

/** The JSON a response carries, read from a clone so the original still streams. */
async function jsonOf(
  response: Response
): Promise<{ read: true; body: unknown } | { read: false }> {
  try {
    return { read: true, body: await response.clone().json() };
  } catch {
    return { read: false };
  }
}

const isRedirect = (status: number) => status >= 300 && status < 400;

/**
 * A response from the Better Auth prefix route, for the sub-path `route` under
 * it. Refusals pass untouched; so does everything in production (`mode`
 * `null`) and a HEAD, which carries no body.
 */
export async function checkBetterAuthResponse(
  mode: ResponseCheckMode | null,
  route: string,
  method: string,
  response: Response
): Promise<Response> {
  if (mode === null || method === 'HEAD') return response;
  const name = pluginCoverageName(route);
  const answered = (problems: readonly string[], id: string) => {
    if (problems.length === 0) {
      recordResponseCoverage(id);
      return response;
    }
    return refused(mode, name, problems, response, () =>
      toWebResponse(invalidResponse())
    );
  };

  const entry = PLUGIN_ENDPOINTS.get(route);
  if (!entry) {
    // The library's own bodies are its shapes; only the challenge this
    // project's hook answers in their place is ours to hold.
    if (response.status !== HTTP_STATUS.OK) return response;
    const json = await jsonOf(response);
    if (
      !json.read ||
      typeof json.body !== 'object' ||
      json.body === null ||
      !('twoFactorRedirect' in json.body)
    )
      return response;
    return answered(
      described(twoFactorChallengeIssues(json.body)),
      challengeCoverageId(route)
    );
  }

  if (isRedirect(response.status)) {
    const problems =
      REDIRECTING.has(route) && response.status === HTTP_STATUS.FOUND
        ? response.headers.get('location')
          ? []
          : ['status 302 without a Location']
        : [`status ${response.status}, expected ${HTTP_STATUS.OK}`];
    return answered(problems, redirectCoverageId(route));
  }
  if (!response.ok) return response;

  const json = await jsonOf(response);
  if (!json.read) return answered(['body: not JSON'], name);
  return answered(
    [
      ...(response.status === HTTP_STATUS.OK
        ? []
        : [`status ${response.status}, expected ${HTTP_STATUS.OK}`]),
      ...described(endpointIssues(entry, json.body)),
    ],
    pluginCoverageId(route, json.body)
  );
}
