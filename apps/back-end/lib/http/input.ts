import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';

/** A body that is not a JSON object of the declared media type. */
export const malformedBody = (): CustomError =>
  new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);

/** Narrows a parsed JSON body to a plain object; 400 for anything else. */
export function requireJsonBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw malformedBody();
  return body as Record<string, unknown>;
}
