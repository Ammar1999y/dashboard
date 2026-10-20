import type { SvgOptimizeResult } from './svg';
import type { SvgJob } from './svg-protocol';
import type {
  SanitizeResult,
  SvgRejectionReason,
} from '@app/shared/images/config';

import * as z from 'zod';

import { SVG_REFUSALS, uploadMsg } from '@app/shared/messages/media';

import { serverFault } from '@/lib/http/response';

import { logLine } from '@/utils/log';

import { createAdmission } from './admission';
import { SVG_WORKER_READY } from './svg-protocol';

const rejectionReason = z.custom<SvgRejectionReason>(
  (value) => typeof value === 'string' && Object.hasOwn(SVG_REFUSALS, value)
);
const messages = z.array(z.string());

/**
 * The worker's answer decides what is stored, so anything not exactly this
 * shape is a 500, never an acceptance.
 */
const sanitizeResultSchema = z.discriminatedUnion('isValid', [
  z.object({
    isValid: z.literal(true),
    cleanedSvg: z.string(),
    errors: messages,
    embeddedRasterMegapixels: z.number(),
  }),
  z.object({
    isValid: z.literal(false),
    cleanedSvg: z.literal(''),
    errors: messages,
    reason: rejectionReason.optional(),
  }),
]);

const optimizeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), svg: z.string() }),
  z.object({
    ok: z.literal(false),
    recheck: z
      .object({ reason: rejectionReason.optional(), errors: messages })
      .nullable(),
  }),
]);

// `fault` first: `z.unknown()` also matches an absent `result`.
const replySchema = z.union([
  z.object({ id: z.number(), fault: z.string() }),
  z.object({ id: z.number(), result: z.unknown() }),
]);

interface Thread {
  worker: Worker;
  ready: Promise<void>;
  pending: {
    id: number;
    resolve: (reply: unknown) => void;
    reject: (error: Error) => void;
  } | null;
  /** `expected` skips the log line, for a stop. */
  discard: (error: Error, expected?: boolean) => void;
}

interface SvgWorkerOptions {
  url: URL;
  queueLimit: number;
  startTimeoutMs: number;
  jobTimeoutMs: number;
}

/**
 * One worker thread, admitted as the encoder is. A thread that times out,
 * crashes or fails to load is terminated and its job answers a 500; the next
 * job starts a fresh one.
 */
export function createSvgWorker(options: SvgWorkerOptions) {
  const acquire = createAdmission(options.queueLimit);
  const state: { thread: Thread | null; nextId: number } = {
    thread: null,
    nextId: 0,
  };

  function spawn(): Thread {
    // Unref'd so an idle thread never holds the process open; the job and
    // start-up timers keep it alive while work is outstanding.
    const worker = new Worker(options.url.href, { ref: false });
    const start = Promise.withResolvers<void>();
    const thread: Thread = {
      worker,
      ready: start.promise,
      pending: null,
      discard,
    };
    const startTimer = setTimeout(() => {
      discard(
        new Error(`svg worker did not start in ${options.startTimeoutMs} ms`)
      );
    }, options.startTimeoutMs);
    const life = { started: false, discarded: false };

    function discard(error: Error, expected = false): void {
      if (life.discarded) return;
      life.discarded = true;
      clearTimeout(startTimer);
      if (state.thread === thread) state.thread = null;
      worker.terminate();
      start.reject(error);
      const { pending } = thread;
      thread.pending = null;
      // Before start-up the job awaiting `ready` gets the error; an idle thread
      // lost after it has no job to report it.
      if (pending) pending.reject(error);
      else if (!expected && life.started)
        logLine('error', {
          msg: 'image.svg worker discarded',
          reason: error.message,
        });
    }

    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data === SVG_WORKER_READY) {
        clearTimeout(startTimer);
        life.started = true;
        start.resolve();
        return;
      }
      const { pending } = thread;
      const reply = replySchema.safeParse(event.data);
      if (!pending || !reply.success || reply.data.id !== pending.id) {
        discard(new Error('svg worker sent an unexpected message'));
        return;
      }
      thread.pending = null;
      if ('fault' in reply.data)
        pending.reject(new Error(`svg worker job threw ${reply.data.fault}`));
      else pending.resolve(reply.data.result);
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      discard(new Error(`svg worker failed: ${event.message}`));
    });
    // Bun's own event, which the DOM typing of `Worker` does not list.
    worker.addEventListener('close', (event) => {
      const code = 'code' in event ? String(event.code) : 'unknown';
      discard(new Error(`svg worker exited with code ${code}`));
    });
    return thread;
  }

  async function run<T>(
    op: SvgJob['op'],
    markup: string,
    schema: z.ZodType<T>
  ): Promise<T> {
    const release = await acquire();
    try {
      state.thread ??= spawn();
      const thread = state.thread;
      await thread.ready;
      const reply = await new Promise<unknown>((resolve, reject) => {
        const id = ++state.nextId;
        const timer = setTimeout(() => {
          thread.discard(
            new Error(`svg worker job exceeded ${options.jobTimeoutMs} ms`)
          );
        }, options.jobTimeoutMs);
        thread.pending = {
          id,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        thread.worker.postMessage({ id, op, markup } satisfies SvgJob);
      });
      const parsed = schema.safeParse(reply);
      if (!parsed.success)
        throw new Error(`svg worker answered a malformed ${op} result`);
      return parsed.data;
    } catch (error) {
      throw serverFault(uploadMsg.uploadFailed, error);
    } finally {
      release();
    }
  }

  return {
    sanitize: (markup: string): Promise<SanitizeResult> =>
      run('sanitize', markup, sanitizeResultSchema),
    optimize: (markup: string): Promise<SvgOptimizeResult> =>
      run('optimize', markup, optimizeResultSchema),
    /** Terminates the thread; a job still running answers a 500. */
    stop: (): void => {
      state.thread?.discard(new Error('svg worker stopped'), true);
    },
  };
}

/**
 * Sized from a cap-sized SVG: about 1.6 s for the whole upload on a loaded
 * box, and up to 6 s for the thread to load its libraries.
 */
const svgWorker = createSvgWorker({
  url: new URL('svg-worker.ts', import.meta.url),
  queueLimit: 4,
  startTimeoutMs: 30_000,
  jobTimeoutMs: 15_000,
});

export const sanitizeSvgInWorker = svgWorker.sanitize;
export const optimizeSvgInWorker = svgWorker.optimize;
export const stopSvgWorker = svgWorker.stop;
