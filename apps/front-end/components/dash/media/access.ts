import type { LibraryFile, LibraryFolder } from '@/lib/media/schemas';

import { useMemo } from 'react';

import { useSession } from '@/lib/auth/use-session';

import { useResourceAccess } from '../shared/access';

/**
 * What the signed-in user may be offered on the library, from the grants on
 * their session. An `own` grant reaches the files they uploaded and the folders
 * they created; the server answers anything else as not found.
 */
export function useMediaAccess() {
  const { userId, can, holds } = useResourceAccess('media');
  const displayName = useSession().data?.user.name ?? '';
  return useMemo(
    () => ({
      userId,
      /** What a folder or file the user creates names as its creator. */
      displayName,
      canCreate: can('create'),
      /** Any scope: whether there is something to offer on the files of one's own. */
      canEdit: can('edit'),
      canDelete: can('delete'),
      canEditFile: ({ uploadedBy }: Pick<LibraryFile, 'uploadedBy'>) =>
        holds('edit', uploadedBy),
      canDeleteFile: ({ uploadedBy }: Pick<LibraryFile, 'uploadedBy'>) =>
        holds('delete', uploadedBy),
      canEditFolder: ({ createdBy }: Pick<LibraryFolder, 'createdBy'>) =>
        holds('edit', createdBy),
      canDeleteFolder: ({ createdBy }: Pick<LibraryFolder, 'createdBy'>) =>
        holds('delete', createdBy),
    }),
    [userId, displayName, can, holds]
  );
}
