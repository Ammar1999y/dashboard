/**
 * Every success a keyed route answers, held to its published contract
 * (`responseIssues`) and to its status: 201 for the `CREATED_ROUTES`, 200
 * otherwise. The Better Auth prefix route holds this project's own plugin
 * endpoints to `BETTER_AUTH_RESPONSES` the same way, and a two-factor challenge
 * from any path to the challenge schema. Under the test runner a mismatch
 * answers 500 and fails the test that caused it; in development it is only
 * logged, because the write behind the answer has already committed and a 500
 * would invite a duplicate retry. Production never runs it.
 */
import type { Handler, HandlerInput, HandlerOutput } from './contract';
import type { ResponseIssue } from '@app/shared/response-contract';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';
import {
  betterAuthResponseIssues,
  isBetterAuthResponseRoute,
  responseIssues,
  twoFactorChallengeIssues,
} from '@app/shared/response-contract';

import { logLine } from '@/utils/log';

import { REDIRECTING_PLUGIN_PATHS } from './openapi/better-auth-tables';
import { CREATED_ROUTES } from './openapi/route-tables';
import { apiError, toWebResponse } from './response';
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

/** What `Response.json` sends for `value`: a `Date` becomes its ISO string. */
const onTheWire = (value: unknown): unknown =>
  // eslint-disable-next-line unicorn/prefer-structured-clone -- not a clone: `structuredClone` keeps a `Date` a `Date`
  JSON.parse(JSON.stringify(value));

/** Paths and codes, never the values that failed. */
const described = (issues: readonly ResponseIssue[]): string[] =>
  issues.map(
    ({ path, code }) => `${path.map(String).join('.') || 'body'}: ${code}`
  );

/**
 * The answer when `problems` is not empty: logged in both modes, and under the
 * runner recorded and replaced by a 500.
 */
function refused<T>(
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

const internalError = () =>
  apiError({
    message: MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
  });

/** `handler` unchanged when it carries no key: only envelope routes are held to a contract. */
export function withResponseCheck(
  handler: Handler,
  mode: ResponseCheckMode
): Handler {
  const key = handler.routeKey;
  if (key === undefined) return handler;
  const expectedStatus = CREATED_ROUTES.has(key)
    ? HTTP_STATUS.CREATED
    : HTTP_STATUS.OK;

  const checked = async (ctx: HandlerInput): Promise<HandlerOutput> => {
    const output = await handler(ctx);
    const { body } = output;
    if (!('success' in body) || !body.success) return output;

    const wire = onTheWire(body);
    const problems = [
      ...(output.status === expectedStatus
        ? []
        : [`status ${output.status}, expected ${expectedStatus}`]),
      ...described(responseIssues(key, wire)),
    ];
    if (problems.length === 0) {
      recordResponseCoverage(responseCoverageId(key, wire));
      return output;
    }
    return refused(mode, key, problems, output, internalError);
  };
  return Object.assign(checked, { routeKey: key });
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
      toWebResponse(internalError())
    );
  };

  if (!isBetterAuthResponseRoute(route)) {
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
      ...described(betterAuthResponseIssues(route, json.body)),
    ],
    pluginCoverageId(route, json.body)
  );
}
