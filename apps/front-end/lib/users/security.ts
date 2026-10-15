import type { SessionsPage } from '@/types/user';
import type { RequestBody } from '@app/shared/contract';
import type { EntityID } from '@app/shared/types';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { useInfiniteQuery } from '@tanstack/react-query';
import { noDataSchema } from '@app/shared/responses/common';
import {
  revokedSessionsSchema,
  sessionsPageSchema,
} from '@app/shared/responses/users';
import { apiRequest } from '@/lib/api/fetch';
import { mutate } from '@/lib/api/mutation';

export type RevokeSessionsBody =
  RequestBody<'DELETE /api/dash/users/:id/sessions'>;

type SessionsData = InfiniteData<SessionsPage, string | null>;

const FIRST_PAGE: string | null = null;

export const sessionsKey = (userId: EntityID) => ['user-sessions', userId];

const sessionsHref = (userId: EntityID) => `/api/dash/users/${userId}/sessions`;

/**
 * A user's live sessions, newest first, a page at a time. Never fresh: a list
 * that looks current while a login or a revocation happened elsewhere would
 * send the reader to end the wrong session.
 */
export function useUserSessions(userId: EntityID) {
  return useInfiniteQuery({
    queryKey: sessionsKey(userId),
    queryFn: async ({ pageParam, signal }) => {
      const query = pageParam
        ? `?${new URLSearchParams({ cursor: pageParam })}`
        : '';
      const { data } = await apiRequest(`${sessionsHref(userId)}${query}`, {
        signal,
        schema: sessionsPageSchema,
      });
      return data;
    },
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });
}

/** One page holding all of `sessions`, with no cursor left to follow. */
const wholeList = (sessions: SessionsPage['sessions']): SessionsData => ({
  pages: [{ sessions, nextCursor: null }],
  pageParams: [FIRST_PAGE],
});

/**
 * Ends the named sessions of a user, or every one but the acting session. The
 * answer lists what was ended: a request naming only the acting session ends
 * nothing and still answers 200. What was asked for is gone from the list
 * either way, as the session that stays is marked `isCurrent`.
 */
export function revokeSessions(
  queryClient: QueryClient,
  userId: EntityID,
  body: RevokeSessionsBody
) {
  const write = () => {
    queryClient.setQueryData<SessionsData>(sessionsKey(userId), (data) => {
      if (!data) return data;
      if ('revokeAll' in body)
        return wholeList(
          data.pages.flatMap((page) => page.sessions).filter((s) => s.isCurrent)
        );
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          sessions: page.sessions.filter(
            (s) => s.isCurrent || !body.sessionIds.includes(s.id)
          ),
        })),
      };
    });
  };

  return mutate({
    href: sessionsHref(userId),
    method: 'DELETE',
    data: body,
    schema: revokedSessionsSchema,
    onSuccess: write,
    onUnreadAnswer: write,
  });
}

/**
 * The loaded sessions of a user, emptied for a write after which the server
 * left them none: a reset of their second factor, or an edit that changed
 * their password, contact or active state.
 */
export function clearCachedSessions(
  queryClient: QueryClient,
  userId: EntityID
) {
  queryClient.setQueryData<SessionsData>(
    sessionsKey(userId),
    (data) => data && wholeList([])
  );
}

/**
 * Clears a user's second factor. The server ends every session of theirs, the
 * acting one too when it is their own account.
 */
export function resetTwoFactor(queryClient: QueryClient, userId: EntityID) {
  const write = () => clearCachedSessions(queryClient, userId);

  return mutate({
    href: `/api/dash/users/${userId}/two-factor/reset`,
    method: 'POST',
    schema: noDataSchema,
    onSuccess: write,
    onUnreadAnswer: write,
  });
}
