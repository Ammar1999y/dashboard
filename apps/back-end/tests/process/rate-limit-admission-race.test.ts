/**
 * Fixed-window admission across processes, against one SQLite file.
 *
 * `SQL_CONSUME` (`lib/rate-limit/store.ts`) claims to be atomic across
 * processes with no explicit transaction. Inside one process the admissions
 * are synchronous and cannot interleave, so only separate processes test the
 * claim. A second cooperating process on one `SQLITE_DIR` is supported (it
 * serves without the schedule until the owner exits), and an over-admitting
 * limiter there would hand one budget out twice.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_rate-limit-admit-child.ts'
);

const PROCESSES = 6;
const ATTEMPTS_EACH = 40;
const LIMIT = 50;
const WINDOW_S = 3600;
const KEY = 'race:admission';
const CASE_TIMEOUT_MS = 60_000;

interface ChildReport {
  admitted: number;
  refused: number;
  storeFailures: number;
  windowStart: number;
  windowEnd: number;
}

const scratch: { dir: string; children: Subprocess[] } = {
  dir: '',
  children: [],
};

beforeEach(() => {
  scratch.dir = mkdtempSync(path.join(os.tmpdir(), 'rate-limit-race-'));
  scratch.children = [];
});

afterEach(async () => {
  // A failed case must not leave siblings writing into a deleted directory.
  for (const child of scratch.children) child.kill();
  await Promise.all(scratch.children.map((child) => child.exited));
  rmSync(scratch.dir, { recursive: true, force: true });
});

function spawnChild(
  yieldWhenBusy: boolean,
  key = KEY,
  attempts = ATTEMPTS_EACH
) {
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      CHILD,
      key,
      String(LIMIT),
      String(WINDOW_S),
      String(attempts),
      yieldWhenBusy ? '1' : '0',
    ],
    {
      cwd: path.join(import.meta.dir, '..', '..'),
      env: { ...process.env, SQLITE_DIR: scratch.dir },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  scratch.children.push(child);
  const lines = readLines(child.stdout);
  return {
    ready: lines.next(),
    go: () => {
      void child.stdin.write('go\n');
      void child.stdin.end();
    },
    report: (async (): Promise<ChildReport> => {
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`child exited ${code}: ${stderr}`);
      let last = '';
      for await (const line of lines) last = line;
      return JSON.parse(last) as ChildReport;
    })(),
  };
}

async function* readLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      yield buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  if (buffered.trim()) yield buffered.trim();
}

// Each mix on its own, too: in the mixed race one path that always refused
// would leave the other three children enough attempts to fill the budget.
describe.each([
  ['blocking busy wait', () => false],
  ['timer retry (yieldWhenBusy)', () => true],
  ['both paths mixed', (index: number) => index % 2 === 1],
] as const)('racing processes on the %s path', (_label, yieldsAt) => {
  test(
    'admit exactly the limit between them, and store it',
    async () => {
      // A run straddling a window boundary may legitimately admit twice:
      // start in the next window instead.
      const toBoundary = WINDOW_S * 1000 - (Date.now() % (WINDOW_S * 1000));
      if (toBoundary < 30_000) await Bun.sleep(toBoundary + 100);

      // Migrated first and alone: concurrent cold opens on win32 fail on their
      // own (`sqlite-migration-race.test.ts`), which is not what this measures.
      const warmup = spawnChild(false, 'warmup', 1);
      await warmup.ready;
      warmup.go();
      await warmup.report;

      const children = Array.from({ length: PROCESSES }, (_, index) =>
        spawnChild(yieldsAt(index))
      );
      // Every child has opened the store before any admits.
      await Promise.all(children.map((child) => child.ready));
      for (const child of children) child.go();
      const reports = await Promise.all(children.map((child) => child.report));

      const windows = new Set(
        reports.flatMap((report) => [report.windowStart, report.windowEnd])
      );
      expect(windows.size).toBe(1);

      const total = (field: 'admitted' | 'refused' | 'storeFailures') =>
        reports.reduce((sum, report) => sum + report[field], 0);
      expect(total('storeFailures')).toBe(0);
      expect(total('admitted')).toBe(LIMIT);
      expect(total('refused')).toBe(PROCESSES * ATTEMPTS_EACH - LIMIT);

      const db = new Database(path.join(scratch.dir, 'rate-limit.db'), {
        readonly: true,
      });
      try {
        const row = db
          .query<{ count: number }, [string]>(
            'SELECT count FROM rate_limit WHERE key = ?'
          )
          .get(KEY);
        expect(row?.count).toBe(LIMIT);
      } finally {
        db.close();
      }
    },
    CASE_TIMEOUT_MS
  );
});
