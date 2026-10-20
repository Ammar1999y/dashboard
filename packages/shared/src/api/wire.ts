/**
 * Every body the API answers with, built and parsed in one place: the server
 * builds with these, the client and the mocks read and answer with them.
 * Errors are RFC 9457 problems; successes are `{ message, data, meta? }`.
 */
import type { MediaRefusalData } from '../responses/media';
import type {
  EndpointDefinition,
  EndpointResponse,
  PagedResponse,
  RawResponse,
} from './endpoint';

import * as z from 'zod';

import { HTTP_STATUS_TITLES } from '../http-status';
import { mediaRefusalDataSchema } from '../responses/media';
import { codesWithIds, isPagedResponse, isRawResponse } from './endpoint';

export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** Every problem's: the status and `code` say what went wrong. */
const PROBLEM_TYPE = 'about:blank';

/** A refusal; `data` names what blocked a media refusal, where its entry says so. */
export const problemSchema = z.object({
  type: z.literal(PROBLEM_TYPE),
  title: z.string().optional(),
  status: z.number().meta({ type: 'integer', minimum: 400, maximum: 599 }),
  detail: z.string(),
  code: z.string().optional(),
  data: mediaRefusalDataSchema.optional(),
});

/** A refusal whose codes never name ids. */
export const plainProblemSchema = problemSchema.omit({ data: true });

/**
 * Every refusal under the Better Auth prefix: `message` repeats `detail` for
 * Better Auth's client, which reads it.
 */
export const authProblemSchema = plainProblemSchema.extend({
  message: z.string(),
});

export type Problem = z.output<typeof problemSchema>;

/** The problem an endpoint's refusal at `status` registers and publishes. */
export const problemSchemaOf = (
  entry: Pick<EndpointDefinition, 'errors'>,
  status: number
): z.ZodObject =>
  codesWithIds(entry, status).length > 0 ? problemSchema : plainProblemSchema;

export function problemBody(
  status: number,
  detail: string,
  code?: string,
  data?: MediaRefusalData
): Problem {
  const title = HTTP_STATUS_TITLES[status];
  return {
    type: PROBLEM_TYPE,
    ...(title !== undefined && { title }),
    status,
    detail,
    ...(code && { code }),
    ...(data && { data }),
  };
}

export function successBody<T, M = undefined>(
  message: string,
  data: T,
  meta?: M
): { message: string; data: T; meta?: M } {
  return { message, data, ...(meta !== undefined && { meta }) };
}

type Envelope<
  D extends z.ZodType,
  M extends z.ZodType | undefined,
> = M extends z.ZodType
  ? z.ZodObject<{ message: z.ZodString; data: D; meta: M }>
  : z.ZodObject<{ message: z.ZodString; data: D }>;

/** The success body around `data`, and `meta` on a list. */
export function successEnvelope<
  D extends z.ZodType,
  M extends z.ZodType | undefined = undefined,
>(data: D, meta?: M): Envelope<D, M> {
  const envelope = meta
    ? z.object({ message: z.string(), data, meta })
    : z.object({ message: z.string(), data });
  return envelope as Envelope<D, M>;
}

/** What a success of an endpoint answering `R` is parsed and validated with. */
export type SuccessSchema<R extends EndpointResponse> =
  R extends RawResponse<infer S>
    ? S
    : R extends PagedResponse<infer D, infer M>
      ? Envelope<D, M>
      : R extends z.ZodType
        ? Envelope<R, undefined>
        : never;

/** The envelope of an endpoint's success, or its raw body. */
export function successSchemaOf<R extends EndpointResponse>(entry: {
  readonly response: R;
}): SuccessSchema<R> {
  const { response } = entry;
  const schema: z.ZodType = isRawResponse(response)
    ? response.raw
    : isPagedResponse(response)
      ? successEnvelope(response.data, response.meta)
      : successEnvelope(response);
  return schema as SuccessSchema<R>;
}
