import type { EntityID } from '@app/shared/types';

import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { sessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { safeDate } from '@app/shared/time';
import { positiveInt, validID } from '@app/shared/utils';
import {
  SESSION_CURSOR_MAX_LENGTH,
  SESSIONS_MAX_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
} from '@app/shared/validation/sessions';

import { userMsg } from './messages';

/**
 * ONE canonical cursor format: `<ISO-8601 UTC with milliseconds>|<uuid>`.
 *
 * Not "anything `Date` can read": `new Date()` normalises rather than rejects,
 * so a permissive form silently points at a different page —
 *
 * - no timezone      → read in the SERVER's zone, a different instant per host
 * - `T24:00:00Z`     → rolled forward to 00:00 the next day
 * - six fraction digits → truncated to millisecond precision
 *
 * `formatCursor` emits none of them, so a correctly paginating client never
 * sends one; everything else is a 422. The range checks below cover what the
 * anchored pattern cannot express.
 */
const CURSOR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** Days in a 1-based month; `day 0` of the next month is the last of this one. */
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Emits the only timestamp form accepted by `parseCursor`. */
export function formatCursor(createdAt: string | Date, id: string): string {
  const date = safeDate(createdAt);
  if (!date) throw new Error('formatCursor received an unparseable timestamp');
  return `${date.toISOString()}|${id}`;
}

/**
 * Components validated directly rather than through `Date`, which would accept
 * an impossible date (`2026-02-30` → 2 March) and an out-of-range hour
 * (`24:00:00` → next day) by normalising them.
 */
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
  // A value that passed every check above must survive the round trip, or the
  // two representations have drifted apart.
  return parsed && parsed.toISOString() === raw ? parsed : null;
}

export function parseCursor(
  raw: string | null
): { createdAt: Date; id: string } | null {
  // Absent and malformed are different answers: treating a corrupted cursor as
  // absent restarts at page one while the client believes it is advancing,
  // which in a revocation list can hide the session it is hunting for.
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

  // Over the maximum is rejected, not clamped: the message promises a value
  // within the cap, and a silent clamp is a lie the client cannot detect.
  const requested = positiveInt(raw, SESSIONS_MAX_PAGE_SIZE);
  if (requested < 1) invalidLimit();
  return requested;
}

function invalidLimit(): never {
  throw new CustomError(
    userMsg.invalidSessionsLimit,
    HTTP_STATUS.UNPROCESSABLE
  );
}

/**
 * One page of the user's unexpired sessions, newest first.
 *
 * Keyset on `(createdAt, id)` rather than OFFSET: session rows are deleted
 * concurrently by every revocation path, and OFFSET would skip or repeat rows
 * as the set shifts underneath the pages.
 */
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
    // One extra row is the cheapest reliable "is there another page" probe.
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
