/**
 * Every error Elysia can raise, and every throw on a binding's way, turned
 * into this API's problem by core. Never Elysia's `problem()`, whose slug
 * `type` would replace the `about:blank` every problem carries. Each answer is a native
 * `Response`, so it passes the exit step like any other.
 *
 * Elysia's `InvalidCookie` is left to the last hook, a logged 500: it is raised
 * only for signed cookies, which nothing configures, and when Elysia
 * serialises a cookie, which nothing asks it to, so it is always a server fault.
 */
import { Elysia, NotFound, ParseError, ValidationError } from 'elysia';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';

import { bindingOf } from '@/lib/http/admit';
import { malformedBody } from '@/lib/http/input';
import { UnreadableBody } from '@/lib/http/request';
import { apiError, toWebResponse } from '@/lib/http/response';
import {
  bindingFailure,
  responseFailure,
  validationFailure,
} from '@/lib/http/run';
import { applySecurityHeaders } from '@/lib/http/security-headers';

import { errorClassOf, logLine } from '@/utils/log';

import { withdrawValue } from './respond';

export function errorMapping(onNotFound: (request: Request) => Response) {
  return (
    new Elysia({ name: 'error-mapping' })
      // A throw in a `parse` hook — the gate's or the counted reader's —
      // arrives wrapped, its own error as the cause. Without one, Elysia's own
      // parser failed on the body.
      .error(ParseError, ({ error, request }) =>
        toWebResponse(
          bindingFailure(
            request,
            error.cause instanceof Error
              ? error.cause
              : new UnreadableBody(malformedBody())
          )
        )
      )
      .error(ValidationError, ({ error, request, set }) => {
        if (error.type !== 'response')
          return toWebResponse(
            validationFailure(request, error.type, error.errors)
          );
        withdrawValue(request, set);
        return toWebResponse(responseFailure(request, error.errors));
      })
      .error(NotFound, ({ request }) => onNotFound(request))
      .error(({ error, request, set }) => {
        if (bindingOf(request))
          return toWebResponse(bindingFailure(request, error));

        // A fault outside any binding (the request hook, the Better Auth prefix
        // route). The message is never echoed: it can carry internals.
        applySecurityHeaders(set.headers);
        logLine('error', {
          msg: 'unhandled server error',
          errorClass: errorClassOf(error),
        });
        return toWebResponse(
          apiError({
            message: MSG_INTERNAL_ERROR,
            status: HTTP_STATUS.INTERNAL_ERROR,
          })
        );
      })
      .as('global')
  );
}
