import type { RevokeSessionsBody } from '@/lib/users/security';
import type { UserSession } from '@/types/user';
import type { EntityID } from '@app/shared/types';

import { memo, useCallback, useMemo, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MSG_SESSION_IDS_TOO_MANY } from '@app/shared/messages/validation';
import { IDS_ARRAY_MAX } from '@app/shared/validation/constants';
import {
  MSG_LOADING,
  MSG_NO_ACTIVE_SESSIONS,
  MSG_REVOKE_ALL_SESSIONS,
  MSG_REVOKE_SELECTED_SESSIONS,
  MSG_SESSIONS_NONE_REVOKED,
  MSG_SESSIONS_REVOKED,
  MSG_USER_SESSIONS_INTRO,
} from '@/constants/messages';
import { revokeSessions, useUserSessions } from '@/lib/users/security';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatDateTime } from '@/components/ui/date/utils';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { ConfirmAction } from '../shared/confirm-action';

interface SessionRowProps {
  session: UserSession;
  selected: boolean;
  disabled: boolean;
  onToggle: (id: EntityID) => void;
}

const SessionRow = memo(
  ({ session, selected, disabled, onToggle }: SessionRowProps) => {
    const { id, isCurrent, userAgent, ipAddress, createdAt } = session;
    const handleToggle = useCallback(() => onToggle(id), [onToggle, id]);

    return (
      <TableRow className='border-none transition-colors duration-300 even:bg-accent/50 hover:bg-accent'>
        <TableCell className='w-10 py-3 text-center'>
          {!isCurrent && (
            <Checkbox
              checked={selected}
              disabled={disabled}
              onCheckedChange={handleToggle}
              aria-label='تحديد الجلسة'
            />
          )}
        </TableCell>
        <TableCell className='py-3'>
          <div className='flex items-center gap-2'>
            <span
              dir='ltr'
              title={userAgent ?? undefined}
              className='bidi-isolate max-w-xs truncate text-start'
            >
              {userAgent ?? '-'}
            </span>
            {isCurrent && <Badge variant='success'>الجلسة الحالية</Badge>}
          </div>
        </TableCell>
        <TableCell className='py-3'>
          <span dir='ltr' className='bidi-isolate num'>
            {ipAddress ?? '-'}
          </span>
        </TableCell>
        <TableCell className='py-3 text-muted-foreground'>
          {formatDateTime(createdAt) ?? '-'}
        </TableCell>
      </TableRow>
    );
  }
);

SessionRow.displayName = 'SessionRow';

interface UserSessionsProps {
  userId: EntityID;
  /** Their own account: the acting session is the one that stays. */
  isSelf: boolean;
}

/**
 * A user's live sessions: who is signed in where, with the means to end some
 * or all of them. Mounted only for a viewer the server lets read them.
 */
export const UserSessions = memo(({ userId, isSelf }: UserSessionsProps) => {
  const queryClient = useQueryClient();
  const {
    data,
    isPending,
    error,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useUserSessions(userId);
  const [selected, setSelected] = useState<ReadonlySet<EntityID>>(
    () => new Set()
  );

  const sessions = useMemo(
    () => data?.pages.flatMap((page) => page.sessions) ?? [],
    [data]
  );
  const revocable = useMemo(
    () => sessions.filter((s) => !s.isCurrent).map((s) => s.id),
    [sessions]
  );
  // A session ended elsewhere leaves the list on its next refetch, and its id
  // must not be sent again.
  const selectedIds = useMemo(
    () => revocable.filter((id) => selected.has(id)),
    [revocable, selected]
  );
  const atLimit = selectedIds.length >= IDS_ARRAY_MAX;
  const allSelected =
    selectedIds.length > 0 &&
    selectedIds.length === Math.min(revocable.length, IDS_ARRAY_MAX);

  const handleToggle = useCallback((id: EntityID) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(
    () =>
      setSelected(
        allSelected ? new Set() : new Set(revocable.slice(0, IDS_ARRAY_MAX))
      ),
    [allSelected, revocable]
  );

  const revoke = useCallback(
    async (body: RevokeSessionsBody) => {
      const { data: answer } = await revokeSessions(queryClient, userId, body);
      if (answer.revoked.length > 0)
        return { message: MSG_SESSIONS_REVOKED(answer.revoked.length) };
      toast.info(MSG_SESSIONS_NONE_REVOKED);
      return {};
    },
    [queryClient, userId]
  );

  const handleRevokeSelected = useCallback(
    () => revoke({ sessionIds: selectedIds }),
    [revoke, selectedIds]
  );
  const handleRevokeAll = useCallback(
    () => revoke({ revokeAll: true }),
    [revoke]
  );
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const handleLoadMore = useCallback(
    () => void fetchNextPage(),
    [fetchNextPage]
  );
  const handleRetry = useCallback(
    () => void (isFetchNextPageError ? fetchNextPage() : refetch()),
    [isFetchNextPageError, fetchNextPage, refetch]
  );

  return (
    <section className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h2 className='text-lg font-bold'>الجلسات النشطة</h2>
          <p className='text-sm text-muted-foreground'>
            {MSG_USER_SESSIONS_INTRO}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <ConfirmAction
            trigger={
              <Button
                type='button'
                variant='outline'
                disabled={selectedIds.length === 0}
              >
                <Icon icon='solar:logout-2-linear' className='size-4' />
                <span>إنهاء المحدد ({selectedIds.length})</span>
              </Button>
            }
            message={MSG_REVOKE_SELECTED_SESSIONS(selectedIds.length)}
            confirmLabel='إنهاء'
            pendingLabel='جاري الإنهاء...'
            run={handleRevokeSelected}
            onDone={clearSelection}
          />
          <ConfirmAction
            trigger={
              <Button
                type='button'
                variant='destructive'
                disabled={revocable.length === 0 && !hasNextPage}
              >
                <Icon icon='solar:logout-3-linear' className='size-4' />
                <span>إنهاء كل الجلسات</span>
              </Button>
            }
            message={MSG_REVOKE_ALL_SESSIONS(isSelf)}
            confirmLabel='إنهاء الكل'
            pendingLabel='جاري الإنهاء...'
            run={handleRevokeAll}
            onDone={clearSelection}
          />
        </div>
      </div>

      {error && <ErrorState error={error} refetch={handleRetry} />}

      {isPending && (
        <p
          role='status'
          className='flex items-center gap-2 text-sm text-muted-foreground'
        >
          <Icon icon='lucide:loader-circle' className='size-4 animate-spin' />
          {MSG_LOADING}
        </p>
      )}

      {data && sessions.length === 0 && (
        <p className='rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground'>
          {MSG_NO_ACTIVE_SESSIONS}
        </p>
      )}

      {sessions.length > 0 && (
        <>
          <Table
            className='w-full min-w-[32rem]'
            containerClassName='rounded-md'
          >
            <TableHeader>
              <TableRow className='bg-accent/50 ltr:[&_th:first-child]:rounded-tl-lg rtl:[&_th:first-child]:rounded-tr-lg ltr:[&_th:last-child]:rounded-tr-lg rtl:[&_th:last-child]:rounded-tl-lg'>
                <TableHead className='w-10 text-center'>
                  {revocable.length > 0 && (
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={handleToggleAll}
                      aria-label='تحديد كل الجلسات'
                    />
                  )}
                </TableHead>
                <TableHead>الجهاز</TableHead>
                <TableHead>عنوان IP</TableHead>
                <TableHead>تاريخ الدخول</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={selected.has(session.id)}
                  disabled={atLimit && !selected.has(session.id)}
                  onToggle={handleToggle}
                />
              ))}
            </TableBody>
          </Table>
          {atLimit && (
            <p className='text-sm text-muted-foreground'>
              {MSG_SESSION_IDS_TOO_MANY}
            </p>
          )}
        </>
      )}

      {hasNextPage && (
        <Button
          type='button'
          variant='outline'
          onClick={handleLoadMore}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? MSG_LOADING : 'عرض المزيد'}
        </Button>
      )}
    </section>
  );
});

UserSessions.displayName = 'UserSessions';
