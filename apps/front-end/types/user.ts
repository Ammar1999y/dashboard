import type {
  sessionsPageSchema,
  userDetailSchema,
} from '@app/shared/responses/users';
import type * as z from 'zod';

export type SessionsPage = z.output<typeof sessionsPageSchema>;

export type UserSession = SessionsPage['sessions'][number];

export type UserDetail = z.output<typeof userDetailSchema>;

/**
 * A user as the cache holds it: a list row and a detail share one entity's
 * keys, so what only the detail carries is optional.
 */
export type UserClient = Pick<
  UserDetail,
  | 'id'
  | 'name'
  | 'email'
  | 'isActive'
  | 'roleId'
  | 'role'
  | 'createdAt'
  | 'updatedAt'
> &
  Partial<UserDetail>;
