import { userDetailSchema } from '@app/shared/responses/users';
import { useQueryData } from '@/lib/api/query';
import { useSession } from '@/lib/auth/use-session';

import { userEntity } from '../users/entity';

/**
 * The signed-in user's own record, which the server answers without any grant.
 * It is the user detail the admin's edit page loads, under the same key: a
 * rename or a contact change written to one is seen in the other.
 */
export function useAccount() {
  const userId = useSession().data?.user.id ?? '';
  return useQueryData({
    queryKey: userEntity.keys.detail(userId),
    href: userEntity.itemHref(userId),
    enabled: !!userId,
    schema: userDetailSchema,
  });
}
