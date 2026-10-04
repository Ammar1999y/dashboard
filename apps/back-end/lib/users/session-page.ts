import type { EntityID } from '@app/shared/types';

import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { sessions } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { userMsg } from '@app/shared/messages/users';
import { safeDate } from '@app/shared/time';
import { positiveInt, validID } from '@app/shared/utils';
import {
  SESSION_CURSOR_MAX_LENGTH,
  SESSIONS_MAX_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
} from '@app/shared/validation/sessions';

/**
 * One canonical form, `formatCursor`'s: `new Date()` normalises instead of
 * rejecting (no zone, `T24:00`, extra fraction digits), so a permissive parse
 * silently points at a different page.
 */
const CURSOR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** Days in a 1-based month; `day 0` of the next month is the last of this one. */
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

export function formatCursor(createdAt: string | Date, id: string): string {
  const date = safeDate(createdAt);
  if (!date) throw new Error('formatCursor received an unparseable timestamp');
  return `${date.toISOString()}|${id}`;
}

// Not through `Date`, which normalises `2026-02-30` to 2 March.
function parseCursorTimestamp(raw: string): Date | null {
  const match = CURSOR_TIMESTAMP.exec(raw);
  if (!match) return null;

  const [, y, mo, d, h, mi, sec] = match;
  const year = Number(y);
  const month = Number(mo);

  if (month < 1 || month > 12) return null;

  const day = Number(d);
  if (
    day < 1 ||
    day > daysInMonth(year, month) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(sec) > 59
  )
    return null;

  const parsed = safeDate(raw);
  return parsed && parsed.toISOString() === raw ? parsed : null;
}

export function parseCursor(
  raw: string | null
): { createdAt: Date; id: string } | null {
  // Malformed is not absent: restarting at page one can hide the session a
  // revocation list is hunting for.
  if (raw === null) return null;
  if (!raw || raw.length > SESSION_CURSOR_MAX_LENGTH) invalidCursor();
  const separator = raw.lastIndexOf('|');
  if (separator <= 0) invalidCursor();
  const id = validID(raw.slice(separator + 1));
  const createdAt = parseCursorTimestamp(raw.slice(0, separator));
  if (!id || !createdAt) invalidCursor();
  return { createdAt, id };
}

function invalidCursor(): never {
  throw new CustomError(
    userMsg.invalidSessionsCursor,
    HTTP_STATUS.UNPROCESSABLE
  );
}

export function parseLimit(raw: string | null): number {
  if (raw === null) return SESSIONS_PAGE_SIZE;

  // Rejected, not clamped: a silent clamp is undetectable by the client.
  const requested = positiveInt(raw, SESSIONS_MAX_PAGE_SIZE);
  if (requested < 1) invalidLimit();
  return requested;
}

function invalidLimit(): never {
  throw new CustomError(
    userMsg.invalidSessionsLimit(SESSIONS_MAX_PAGE_SIZE),
    HTTP_STATUS.UNPROCESSABLE
  );
}

// Keyset, not OFFSET: revocations delete rows concurrently, and OFFSET would
// skip or repeat them.
export async function readSessionsPage(opts: {
  userId: EntityID;
  currentSessionId: EntityID | null;
  limit: number;
  cursor: { createdAt: Date; id: string } | null;
}) {
  const { cursor, limit } = opts;
  const rows = await db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, opts.userId),
        gt(sessions.expiresAt, sql`now()`),
        cursor
          ? sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.createdAt}, ${cursor.id}::uuid)`
          : undefined
      )
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    sessions: page.map((s) => ({
      ...s,
      isCurrent: s.id === opts.currentSessionId,
    })),
    hasMore,
    nextCursor: hasMore && last ? formatCursor(last.createdAt, last.id) : null,
  };
}
