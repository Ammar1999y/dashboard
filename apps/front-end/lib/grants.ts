import type { ActorPermissions } from '@app/shared/permissions/scope';

import { useMemo } from 'react';

import * as z from 'zod';
import { sanitizePermissions } from '@app/shared/permissions/matrix';
import { useSession } from '@/lib/auth/use-session';

const grantsSchema = z.object({
  metadata: z.object({ permissions: z.record(z.string(), z.unknown()) }),
});

const roleSchema = z.object({ metadata: z.object({ roleId: z.string() }) });

/**
 * The permission matrix the server put on the session at sign-in, which is what
 * its routes read too, sanitized as the server sanitizes it. A session without
 * one, such as an account with no role, holds no grants.
 */
export function readGrants(session: unknown): ActorPermissions {
  const parsed = grantsSchema.safeParse(session);
  if (!parsed.success) return {};
  return sanitizePermissions(
    Object.entries(parsed.data.metadata.permissions).map(
      ([pageName, permissions]) => ({ pageName, permissions })
    )
  );
}

/** The role the session was signed in under, or `null` for an account without one. */
export function readRoleId(session: unknown): string | null {
  const parsed = roleSchema.safeParse(session);
  return parsed.success ? parsed.data.metadata.roleId : null;
}

/**
 * The signed-in user's grants, for deciding what to offer. The server decides
 * what to allow: a stale or missing grant here hides an action, never opens one.
 */
export function useGrants() {
  const session = useSession().data;
  return useMemo(
    () => ({
      userId: session?.user.id ?? '',
      roleId: readRoleId(session?.session),
      permissions: readGrants(session?.session),
    }),
    [session]
  );
}
