/**
 * Framework-independent post-response work. Audit writes remain transactional
 * because losing them after a committed mutation would break the audit trail.
 */
import { CustomError } from '@app/shared/error-class';

import {
  errorClassOf,
  logLine,
  logSanitized,
  serializeForLog,
  thrownAt,
} from '@/utils/log';

type AfterResponseTask = () => void | Promise<void>;

interface RequestSummary {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/** The raw request is the framework-independent handle shared by both stages. */
const queues = new WeakMap<Request, AfterResponseTask[]>();

/**
 * Requests whose queue has run, with their log path. Work that queues itself
 * after that point (an issuance still running when its response went out) would
 * sit in a queue nobody runs, so it is run at once instead.
 */
const flushed = new WeakMap<Request, string>();

const inFlight = new Set<Promise<void>>();

export function enqueueAfterResponse(
  request: Request,
  task: AfterResponseTask
): void {
  const path = flushed.get(request);
  if (path !== undefined) {
    track([task], path);
    return;
  }
  const queue = queues.get(request);
  if (queue) queue.push(task);
  else queues.set(request, [task]);
}

/** Isolates task failures because the response is already committed. */
export function runAfterResponse(
  request: Request,
  summary: RequestSummary
): void {
  const queue = queues.get(request) ?? [];
  queues.delete(request);

  // The client's path, so bounded and stripped like any caller string.
  const path = serializeForLog(summary.path);
  logRequest({ ...summary, path });
  flushed.set(request, path);
  if (queue.length === 0) return;

  track(queue, path);
}

function track(queue: AfterResponseTask[], path: string): void {
  const settled = (async () => {
    for (const task of queue) {
      try {
        await task();
      } catch (error) {
        // The class only, unless it is ours: a `CustomError`'s `cause` is the
        // diagnosis its raiser chose to log, as `logServerErrorResponse` does.
        logSanitized('error', {
          msg: 'after-response task failed',
          path,
          errorClass: errorClassOf(error),
          ...(error instanceof CustomError && {
            thrownAt: thrownAt(error),
            cause: error.cause,
          }),
        });
      }
    }
  })();

  inFlight.add(settled);
  void settled.finally(() => inFlight.delete(settled));
}

/** Omits query strings and headers because both can contain user identifiers. */
function logRequest(summary: RequestSummary): void {
  logLine('log', {
    msg: 'request',
    method: summary.method,
    path: summary.path,
    status: summary.status,
    durationMs: Math.round(summary.durationMs),
  });
}

export function pendingAfterResponse(): number {
  return inFlight.size;
}

export const AFTER_RESPONSE_SETTLE_MS = 50;

/**
 * Waits for queued post-response work, up to `timeoutMs`.
 *
 * True ONLY when the queue was observed empty for `AFTER_RESPONSE_SETTLE_MS` and
 * that observation finished strictly before the deadline; never waits past the
 * deadline to finish one. The settle period is the proof — it catches a batch
 * registered while another was finishing — so an exhausted deadline answers
 * false even when the set is empty at that instant: the shutdown that asks must
 * not close stores on an unproven answer.
 */
export async function drainAfterResponse(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (inFlight.size === 0) {
      // A complete observation has to fit; a partial one proves nothing, and
      // sleeping past the deadline to finish it would break "up to timeoutMs".
      if (deadline - Date.now() < AFTER_RESPONSE_SETTLE_MS) return false;
      await Bun.sleep(AFTER_RESPONSE_SETTLE_MS);
      if (inFlight.size === 0 && Date.now() < deadline) return true;
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // A rejected batch must not abandon the rest of the drain.
    await Promise.race([
      Promise.all(inFlight).catch(() => {}),
      Bun.sleep(Math.min(remaining, AFTER_RESPONSE_SETTLE_MS * 4)),
    ]);
  }

  return false;
}
