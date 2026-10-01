/**
 * Empties the limiter store between tests.
 *
 * For a suite whose SUBJECT is what a route does, not how often it may be
 * called: the media library's two upload routes share one per-user admission
 * budget (`UPLOAD_ADMISSION_SCOPE`, 40 a minute), and a file that drives every
 * upload path through one account spends that window on fixtures and then reads
 * its own 429s as failures of the thing under test. `tests/integration/media-folders.test.ts`
 * avoids the same trap by seeding its fixtures through the database, which a
 * suite about uploading cannot do.
 *
 * Never call this from a test that asserts a limit.
 */
import { getRateLimitStore } from '@/lib/rate-limit/store';

export function resetRateLimits(): void {
  getRateLimitStore().db.exec('delete from rate_limit');
}

/**
 * Deletes the windows a forward-moved clock wrote. Call it where the test puts
 * the real clock back, never before: it compares against `Date.now()`.
 *
 * The store charges a caller whose window is older than the stored one to the
 * stored one, so a row left in a future window throttles every real-clock
 * caller on its key until real time reaches it — in this file and in every
 * later file sharing the worker's store. A real clock never writes a future
 * window, so this is safe in a file that asserts a limit.
 */
export function dropMockedClockWindows(): void {
  getRateLimitStore().db.exec(
    `delete from rate_limit where window_start > ${Date.now()}`
  );
}
