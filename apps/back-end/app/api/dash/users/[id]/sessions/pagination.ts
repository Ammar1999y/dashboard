import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { safeDate } from '@app/shared/time';
import { validID } from '@app/shared/utils';
import {
  SESSION_CURSOR_MAX_LENGTH,
  SESSIONS_MAX_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
} from '@app/shared/validation/sessions';

import { userMsg } from '@/lib/users/messages';

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

/**
 * Canonical decimal integers only, checked before any numeric conversion:
 * `Number()` also reads `1e2`, `0x10`, `+1`, `' 5 '` and `'05'`, which would let
 * a caller spell past the cap.
 */
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

export function parseLimit(raw: string | null): number {
  if (raw === null) return SESSIONS_PAGE_SIZE;

  // Over the maximum is rejected, not clamped: the message promises a value
  // within the cap, and a silent clamp is a lie the client cannot detect.
  if (!CANONICAL_INTEGER.test(raw)) invalidLimit();
  const requested = Number(raw);
  if (requested < 1 || requested > SESSIONS_MAX_PAGE_SIZE) invalidLimit();
  return requested;
}

function invalidLimit(): never {
  throw new CustomError(
    userMsg.invalidSessionsLimit,
    HTTP_STATUS.UNPROCESSABLE
  );
}
