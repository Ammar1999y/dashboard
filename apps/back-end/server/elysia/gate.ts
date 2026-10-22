/**
 * The gate as a macro, so admission runs before Elysia reads or validates
 * anything. A JSON binding is gated in `parse`, which runs before any body
 * byte is read, and then reads its body through the counted reader; every
 * other binding is gated in `transform` and declares `parse: 'none'`, so no
 * parser touches its body. The handler's actor is the gate's, read back
 * by `runBinding`, which fails closed when the gate did not run.
 */
import type { AnyBinding } from '@/lib/http/binding';
import type { Server } from 'elysia';

import { Elysia } from 'elysia';

import { admit } from '@/lib/http/admit';
import { bodyPolicyCeiling, readJsonObject } from '@/lib/http/request';

interface GateContext {
  request: Request;
  server: Server | null;
  /** The router's, decoded; validation has not run yet. */
  params: Record<string, string | undefined>;
}

async function admitted(
  { request, server, params }: GateContext,
  binding: AnyBinding
): Promise<void> {
  await admit(request, binding, params);
  // `server` is null under `app.handle`: the extension exists only live.
  if (binding.options.timeoutSeconds !== undefined)
    server?.timeout(request, binding.options.timeoutSeconds);
}

export const gate = new Elysia({ name: 'gate' })
  .macro({
    binding: (binding: AnyBinding) => ({
      ...(binding.entry.bodyKind === 'json' && {
        async parse(context: GateContext) {
          await admitted(context, binding);
          return readJsonObject(
            context.request,
            bodyPolicyCeiling('json', binding.options.maxJsonBodyBytes)
          );
        },
      }),
      async transform(context: GateContext) {
        await admitted(context, binding);
      },
    }),
  })
  .as('global');
