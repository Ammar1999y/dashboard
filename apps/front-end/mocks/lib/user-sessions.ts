import type { MockUserSession } from '../store';
import type { EntityID } from '@app/shared/types';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { userMsg } from '@app/shared/messages/users';
import { safeDate } from '@app/shared/time';
import { positiveInt, validID } from '@app/shared/utils';
import {
  SESSION_CURSOR_MAX_LENGTH,
  SESSION_CURSOR_PATTERN,
  SESSIONS_MAX_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
} from '@app/shared/validation/sessions';

import { session, userSessions } from '../store';

// A published constant, not input.
// eslint-disable-next-line security/detect-non-literal-regexp
const CURSOR = new RegExp(SESSION_CURSOR_PATTERN);

const invalidCursor = () =>
  new CustomError(userMsg.invalidSessionsCursor, HTTP_STATUS.UNPROCESSABLE);

/** The server's `parseLimit`: refused when out of range, never clamped. */
export function parseSessionsLimit(raw: string | null): number {
  if (raw === null) return SESSIONS_PAGE_SIZE;
  const requested = positiveInt(raw, SESSIONS_MAX_PAGE_SIZE);
  if (requested < 1)
    throw new CustomError(
      userMsg.invalidSessionsLimit(SESSIONS_MAX_PAGE_SIZE),
      HTTP_STATUS.UNPROCESSABLE
    );
  return requested;
}

interface Cursor {
  createdAt: string;
  id: EntityID;
}

/** The server's `parseCursor`: malformed is refused, not read as page one. */
export function parseSessionsCursor(raw: string | null): Cursor | null {
  if (raw === null) return null;
  if (!raw || raw.length > SESSION_CURSOR_MAX_LENGTH || !CURSOR.test(raw))
    throw invalidCursor();
  const separator = raw.lastIndexOf('|');
  const createdAt = raw.slice(0, separator);
  const id = validID(raw.slice(separator + 1));
  // `2026-02-30` matches the pattern and is no day.
  if (!id || safeDate(createdAt)?.toISOString() !== createdAt)
    throw invalidCursor();
  return { createdAt, id };
}

/** The mocks' own session, which the server would list like any other. */
const currentSessionRow = (userId: EntityID): MockUserSession | undefined => {
  const current = session.get()?.session;
  if (current?.userId !== userId) return undefined;
  return {
    id: current.id,
    userId,
    ipAddress: '127.0.0.1',
    userAgent: globalThis.navigator?.userAgent ?? null,
    createdAt: current.createdAt,
  };
};

/** Newest first, ties by id: the order the server's keyset pages follow. */
const newestFirst = (a: MockUserSession, b: MockUserSession) =>
  a.createdAt === b.createdAt
    ? Number(a.id < b.id) - Number(a.id > b.id)
    : Number(a.createdAt < b.createdAt) - Number(a.createdAt > b.createdAt);

/** The server's `readSessionsPage`: one keyset page of a user's live sessions. */
export function readSessionsPage({
  userId,
  limit,
  cursor,
}: {
  userId: EntityID;
  limit: number;
  cursor: Cursor | null;
}) {
  const currentId = session.get()?.session.id;
  const own = userSessions.all().filter((row) => row.userId === userId);
  const current = currentSessionRow(userId);
  const rows = (current ? [...own, current] : own)
    .toSorted(newestFirst)
    .filter(
      (row) =>
        !cursor ||
        row.createdAt < cursor.createdAt ||
        (row.createdAt === cursor.createdAt && row.id < cursor.id)
    );

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const hasMore = rows.length > limit;

  return {
    sessions: page.map(({ id, ipAddress, userAgent, createdAt }) => ({
      id,
      ipAddress,
      userAgent,
      createdAt,
      isCurrent: id === currentId,
    })),
    hasMore,
    nextCursor: hasMore && last ? `${last.createdAt}|${last.id}` : null,
  };
}

/**
 * Ends sessions of `userId`: the named ones, or all. The mocks' own session is
 * never among them, as the server's acting session is not. Answers the ids
 * ended.
 */
export function revokeUserSessions(
  userId: EntityID,
  which: readonly EntityID[] | 'all'
): EntityID[] {
  const ended = userSessions
    .all()
    .filter(
      (row) =>
        row.userId === userId && (which === 'all' || which.includes(row.id))
    )
    .map((row) => row.id);
  for (const id of ended) userSessions.remove(id);
  return ended;
}
