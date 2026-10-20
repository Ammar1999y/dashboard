/**
 * A binding's handler, run, and every failure on its way mapped to a problem. Framework-free: `server/elysia` hands in what it validated and
 * sends what comes back.
 */
import type { AnyBinding, AnyBindingResult, InputPart } from './binding';
import type { HandlerError, HandlerOutput } from './contract';
import type * as z from 'zod';

import { codesWithIds, declaredCodes } from '@app/shared/api/endpoint';
import { successBody } from '@app/shared/api/wire';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
} from '@app/shared/messages/common';
import { idsAreOptional } from '@app/shared/responses/media';
import {
  authoredMessage,
  issueCodeMessage,
  zodIssueMessage,
} from '@app/shared/validation/rules';

import { logLine } from '@/utils/log';

import {
  actorOf,
  bindingOf,
  chargeRateLimit,
  CredentialRefused,
} from './admit';
import { queryKeysOf } from './binding';
import { refusalsOf } from './refusals';
import { buildRequestMeta, UnreadableBody, withBodyPolicy } from './request';
import { apiError, apiRaw, handleApiError, invalidResponse } from './response';
import {
  checkSuccess,
  described,
  refused,
  responseCheckMode,
} from './response-check';
import { timingFloor } from './timing-floor';

const responseCheck = responseCheckMode();

export async function runBinding(
  binding: AnyBinding,
  request: Request,
  input: { params: unknown; query: unknown; body: unknown }
): Promise<HandlerOutput> {
  const { entry, options } = binding;
  const actor = actorOf(request);
  // After validation, so params' own refusal (a malformed id's 404) precedes it.
  if (repeatsDeclaredKey(binding, request.url))
    return declared(
      binding,
      inputRefusal(binding, 'query', MSG_INVALID_INPUT, false),
      'input'
    );
  const requestMeta = buildRequestMeta(request);
  const { params: _params, query: _query, ...meta } = requestMeta;
  const floor = options.timingFloor ? timingFloor() : undefined;
  let charged: Promise<void> | undefined;

  let result: AnyBindingResult;
  try {
    result = await binding.invoke({
      ...input,
      actor,
      meta: {
        ...meta,
        ...(floor && { startFloor: floor.start }),
        ...(options.rateLimit?.deferred && {
          chargeRateLimit: () =>
            (charged ??= chargeRateLimit(binding, actor, request.headers)),
        }),
        // The lazy reader, so the handler reads the form after its own checks.
        ...(entry.bodyKind === 'multipart' && {
          readFormData: withBodyPolicy(requestMeta, 'multipart').readFormData,
        }),
      },
    });
  } catch (error) {
    const mapped = options.mapError?.(error);
    if (mapped) return declared(binding, mapped, 'handler');
    throw error;
  } finally {
    await floor?.settle();
  }

  if (charged === undefined && options.rateLimit?.deferred)
    throw new Error(`${binding.key} answered without charging its limiter.`);

  return outputOf(binding, result);
}

/** A handler's answer, or a credential refusal answered as one, on the wire. */
function outputOf(
  binding: AnyBinding,
  result: AnyBindingResult
): HandlerOutput {
  const { entry } = binding;
  if ('raw' in result)
    return apiRaw({
      body: result.raw,
      status: result.status ?? entry.status,
      ...(result.headers && { headers: result.headers }),
    });

  const body = successBody(result.message, result.data, result.meta);
  if (responseCheck !== null && !checkSuccess(responseCheck, binding, body))
    return invalidResponse();

  return {
    status: entry.status,
    body,
    ...(result.headers && { headers: result.headers }),
    ...(result.cookies && { cookies: result.cookies }),
  };
}

const queryKeys = new WeakMap<AnyBinding, ReadonlySet<string>>();

/**
 * A key the query declares, named twice: Elysia keeps the last value, so one
 * meaning is a refusal. An undeclared key means nothing to the route, which
 * ignores it or, strict, refuses it as unknown.
 */
function repeatsDeclaredKey(binding: AnyBinding, url: string): boolean {
  if (!binding.entry.query) return false;
  let declared = queryKeys.get(binding);
  if (!declared) {
    declared = new Set(queryKeysOf(binding.entry));
    queryKeys.set(binding, declared);
  }
  const named = new URL(url).searchParams
    .keys()
    .filter((key) => declared.has(key))
    .toArray();
  return new Set(named).size !== named.length;
}

const internalError = (): HandlerError =>
  apiError({ message: MSG_INTERNAL_ERROR, status: HTTP_STATUS.INTERNAL_ERROR });

/**
 * Any throw on a binding's way that its own mapping left, the gate's included:
 * the shared mapping with the binding's failure message.
 */
export function bindingFailure(
  request: Request,
  error: unknown
): HandlerOutput {
  const binding = bindingOf(request);
  if (binding && error instanceof CredentialRefused)
    return outputOf(binding, error.answer);
  if (error instanceof UnreadableBody) {
    const answer = unreadableBody(binding, error);
    return binding ? declared(binding, answer, 'input') : answer;
  }
  const answer = handleApiError(error, binding?.options.failure);
  return binding ? declared(binding, answer, 'handler') : answer;
}

/**
 * A request part that failed its schema: the binding's override for that
 * part, else 422 naming the first issue.
 */
export function validationFailure(
  request: Request,
  part: string | undefined,
  issues: readonly unknown[]
): HandlerError {
  const { message, authored } = firstIssueMessage(issues);
  const binding = bindingOf(request);
  const answer = inputRefusal(
    binding,
    isInputPart(part) ? part : undefined,
    message,
    authored
  );
  return binding ? declared(binding, answer, 'input') : answer;
}

/**
 * The first issue's message. One whose code-specific fields were scoped away
 * stays the first: it is worded by its code, never skipped for the next.
 */
function firstIssueMessage(issues: readonly unknown[]): {
  message: string;
  authored: boolean;
} {
  const first = issues.find(isIssueHead);
  if (first === undefined)
    return { message: MSG_INVALID_INPUT, authored: false };
  if (!isZodIssue(first))
    return {
      message: issueCodeMessage(first.code, first.path),
      authored: false,
    };
  return {
    message: zodIssueMessage([first]),
    authored: authoredMessage(first) !== undefined,
  };
}

/**
 * Every refusal a binding answers passes here, held like a success to what its
 * entry publishes: a status `refusalsOf` does not list, a `code` the entry
 * neither declares at that status nor implies by policy, a 400 from past the
 * input that the entry does not declare (undeclared, a 400 is published as the
 * input's own), ids in `data` where the entry does not declare them, or none
 * where it does and the code always names them, is a contract bug.
 */
function declared(
  binding: AnyBinding,
  answer: HandlerError,
  source: 'input' | 'handler'
): HandlerError {
  if (responseCheck === null) return answer;
  const problem = refusalProblem(binding, answer, source);
  return problem === undefined
    ? answer
    : refused(responseCheck, binding.key, [problem], answer, internalError);
}

function refusalProblem(
  binding: AnyBinding,
  { status, body: { code, data } }: HandlerError,
  source: 'input' | 'handler'
): string | undefined {
  const { entry } = binding;
  if (!publishedStatuses(binding).has(status))
    return `status ${status} is not published`;
  if (
    source === 'handler' &&
    status === HTTP_STATUS.BAD_REQUEST &&
    !entry.errors?.[HTTP_STATUS.BAD_REQUEST]
  )
    return 'a business 400 is not declared';
  if (code === undefined)
    return data === undefined ? undefined : `ids without a code at ${status}`;
  if (!declaredCodes(entry, status).includes(code))
    return `code ${code} is not declared at ${status}`;
  const declaredWithIds: readonly string[] = codesWithIds(entry, status);
  const withIds = declaredWithIds.includes(code);
  if (data !== undefined && !withIds)
    return `code ${code} names ids at ${status}, which the entry does not declare`;
  if (data === undefined && withIds && !idsAreOptional(code))
    return `code ${code} names no ids at ${status}`;
  return undefined;
}

const published = new WeakMap<AnyBinding, ReadonlySet<number>>();

function publishedStatuses(binding: AnyBinding): ReadonlySet<number> {
  let statuses = published.get(binding);
  if (!statuses) {
    statuses = new Set(refusalsOf(binding).map(({ status }) => status));
    published.set(binding, statuses);
  }
  return statuses;
}

const INPUT_PARTS: ReadonlySet<string> = new Set(['params', 'query', 'body']);

const isInputPart = (part: string | undefined): part is InputPart =>
  part !== undefined && INPUT_PARTS.has(part);

/**
 * A success body that failed its own schema: a server bug, answered 500 and
 * logged by paths and issue codes, never the values.
 */
export function responseFailure(
  request: Request,
  issues: readonly unknown[]
): HandlerError {
  logLine('error', {
    msg: 'response.validation.failed',
    route: bindingOf(request)?.key,
    problems: described(issues.filter(isIssueHead)),
  });
  return invalidResponse();
}

function unreadableBody(
  binding: AnyBinding | undefined,
  error: UnreadableBody
): HandlerError {
  const override = binding?.options.refusals?.unreadableBody;
  return override
    ? apiError(override)
    : handleApiError(error.refusal, binding?.options.failure);
}

function inputRefusal(
  binding: AnyBinding | undefined,
  part: InputPart | undefined,
  message: string,
  authored: boolean
): HandlerError {
  const override = part && binding?.options.refusals?.[part];
  if (!override)
    return apiError({ message, status: HTTP_STATUS.UNPROCESSABLE });
  if (override.message !== undefined) return apiError(override);
  return apiError({
    status: override.status,
    message: authored ? message : (override.unauthored ?? message),
  });
}

/**
 * Elysia hands validation issues over untyped, and past an 8 KiB echo budget
 * shared by all of them replaces any field but `path` with a placeholder
 * string: `message`, a code's own fields, and `code` itself on a later issue.
 * Nothing here reads a field these guards did not check.
 */
type IssueHead = z.core.$ZodIssueBase & { readonly code: string };

function isIssueHead(issue: unknown): issue is IssueHead {
  return (
    typeof issue === 'object' &&
    issue !== null &&
    'code' in issue &&
    typeof issue.code === 'string' &&
    'path' in issue &&
    Array.isArray(issue.path) &&
    issue.path.every(isPropertyKey) &&
    'message' in issue &&
    typeof issue.message === 'string'
  );
}

/** Every code-specific field `localizedIssueMessage` reads, checked. */
function isZodIssue(issue: IssueHead): issue is z.core.$ZodIssue {
  return (
    issue.code !== 'unrecognized_keys' ||
    ('keys' in issue &&
      Array.isArray(issue.keys) &&
      issue.keys.every((key) => typeof key === 'string'))
  );
}

const isPropertyKey = (key: unknown): key is PropertyKey =>
  typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol';
