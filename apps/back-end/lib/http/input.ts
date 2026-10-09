import type { HandlerInput } from './contract';
import type { EntityID } from '@app/shared/types';
import type { z } from 'zod';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import { idRequired } from '@app/shared/messages/validation';
import { validID } from '@app/shared/utils';
import { zodIssueMessage } from '@app/shared/validation/rules';

/** Narrows a parsed JSON body to a plain object; 400 for anything else. */
export function requireJsonBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
  return body as Record<string, unknown>;
}

/**
 * What a failed schema answers. By default 422 naming the first issue; the
 * anonymous OTP routes pass a fixed `message` because a per-field one reveals
 * which branch of the channel union the input matched.
 */
interface SchemaRefusal {
  message?: string;
  status?: number;
}

export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  refusal: SchemaRefusal = {}
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CustomError(
      refusal.message ?? zodIssueMessage(parsed.error),
      refusal.status ?? HTTP_STATUS.UNPROCESSABLE
    );
  return parsed.data;
}

/** The JSON body, read at the call site's chosen moment: 400 before 422. */
export async function readJsonBody<S extends z.ZodType>(
  ctx: HandlerInput,
  schema: S,
  refusal?: SchemaRefusal
): Promise<z.output<S>> {
  return parseOrThrow(schema, requireJsonBody(await ctx.readJson()), refusal);
}

const malformedId = () =>
  new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

/**
 * A canonical id or a refusal. The media and two-factor routes pass their
 * not-found, so a malformed id reads like an id that matched nothing.
 */
export function requireId(
  value: unknown,
  refusal: () => CustomError = malformedId
): EntityID {
  const id = validID(value);
  if (!id) throw refusal();
  return id;
}
