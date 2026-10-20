import type { EntityKeys } from '@/lib/api/query-cache';
import type { UserDetail } from '@/types/user';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { updateSelf } from '@app/shared/api/users';
import { api } from '@/lib/api/client';
import { cacheUpdated } from '@/lib/api/query-cache';
import { authClient } from '@/lib/auth/client';

/**
 * Shows the new name in everything that reads the session. The server answers
 * a session read from a cookie cache for minutes after a rename, so reading it
 * again would put the old name back; the atom is written instead.
 */
function patchSessionUsername(name: string) {
  const atom = authClient.$store.atoms.session;
  const current = atom?.get();
  if (!atom || !current?.data) return;
  atom.set({
    ...current,
    data: { ...current.data, user: { ...current.data.user, name } },
  });
}

interface UserEntityRef {
  keys: EntityKeys;
}

/**
 * The signed-in user renames their own record, the one change the endpoint
 * takes for it (no grant, no proof). The cached detail and every list row, and
 * the session's name, follow once the server has committed, or when its answer
 * was lost.
 */
export function renameSelf(
  queryClient: QueryClient,
  entity: UserEntityRef,
  id: EntityID,
  name: string
) {
  const write = (updatedAt: string) => {
    cacheUpdated<UserDetail>(queryClient, entity.keys, id, { name, updatedAt });
    patchSessionUsername(name);
  };

  return api(
    updateSelf,
    { body: { name } },
    {
      onSuccess: ({ updatedAt }) => write(updatedAt),
      onUnreadAnswer: () => write(new Date().toISOString()),
    }
  );
}
