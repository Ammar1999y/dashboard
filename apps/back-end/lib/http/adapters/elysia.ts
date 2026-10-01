import type { HandlerOutput, HandlerRequestMeta } from '../contract';
import type { RouteDefinition } from '../route-manifest';

import { withQueuedCookies } from '../cookies';
import { assertSameOriginWrite } from '../origin';
import { enforcePreAuthIpLimit } from '../pre-auth';
import { buildRequestMeta, withBodyPolicy } from '../request';
import { handleApiError, toWebResponse } from '../response';

/**
 * The subset of Elysia's route context this adapter reads — structural, because
 * Elysia's exported `Context` is generic over the whole instance's inference
 * and naming it would drag the app's type graph into every handler module. The
 * `app.ts` call sites check that Elysia's context satisfies it.
 */
interface ElysiaRouteContext {
  request: Request;
  params: Record<string, string>;
  /** `null` outside a live listener, matching Elysia's `Server['timeout']`. */
  server: { timeout(request: Request, seconds: number): void } | null;
}

/**
 * Lifts a framework-agnostic `Handler` into an Elysia route handler.
 *
 * The order is the security-relevant part:
 *
 *   1. read the request head — no body byte is touched
 *   2. run admission checks (the origin check, the coarse per-IP limit)
 *      against that head
 *   3. extend the per-request timeout, if the route asked for one
 *   4. hand the handler LAZY readers, gated to the shape the route declared
 *
 * Every response, a refusal included, carries the cookies the session reads
 * queued (`withQueuedCookies`); a 401 is often what delivers their expiry.
 *
 * ⚠️ Every route registered with this MUST use `elysiaRouteConfig`: Elysia
 * parses the body into `ctx.body` by default, which drains the stream the
 * readers need.
 */
export function toElysiaHandler(route: RouteDefinition) {
  return async (ctx: ElysiaRouteContext): Promise<Response> => {
    let meta: HandlerRequestMeta | undefined;
    const respond = (output: HandlerOutput) =>
      toWebResponse(meta ? withQueuedCookies(output, meta.headers) : output);

    try {
      meta = buildRequestMeta(ctx.request, ctx.params ?? {});
      assertSameOriginWrite(meta);
      if (route.preAuth === 'ip-limit') await enforcePreAuthIpLimit(meta);
      if (route.timeoutSeconds !== undefined)
        ctx.server?.timeout(ctx.request, route.timeoutSeconds);
      return respond(
        await route.handler(
          withBodyPolicy(meta, route.body, route.maxJsonBodyBytes)
        )
      );
    } catch (error) {
      return respond(handleApiError(error));
    }
  };
}

/** The route options every adapter-registered route is registered with. */
export const elysiaRouteConfig = { parse: 'none' } as const;
