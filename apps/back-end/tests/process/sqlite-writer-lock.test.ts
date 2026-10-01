import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tryAcquireWriterLock } from '@/lib/sqlite/writer-lock';

const HOLDER = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_writer-lock-child.ts'
);

const created: string[] = [];

function claim(directory: string) {
  const lock = tryAcquireWriterLock(directory);
  if (!lock)
    throw new Error(`expected to win the writer lock for ${directory}`);
  return lock;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'writer-lock-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function startHolder(directory: string) {
  const child = Bun.spawn(['bun', '--no-env-file', HOLDER, directory], {
    cwd: path.join(import.meta.dir, '..', '..'),
    env: { ...process.env, NODE_ENV: 'development' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 15_000;
  let buffered = '';
  while (Date.now() < deadline && !buffered.includes('"held":true')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  if (!buffered.includes('"held":true'))
    throw new Error(`holder never reported the lock. Output: ${buffered}`);
  return child;
}

describe('the writer lock', () => {
  test('a second acquirer in another process loses the election without throwing', async () => {
    const directory = tempDir();
    const holder = await startHolder(directory);

    try {
      expect(tryAcquireWriterLock(directory)).toBeNull();
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 60_000);

  test('a hard-killed holder does not leave the lock stuck', async () => {
    // The reason this is a SQLite transaction and not a lock file: a plain file
    // needs stale-entry handling, because a killed process leaves one behind and
    // the next boot cannot tell "held" from "abandoned". An OS file lock is
    // released by the kernel.
    const directory = tempDir();
    const holder = await startHolder(directory);
    holder.kill(9);
    await holder.exited;

    const lock = claim(directory);
    expect(lock.release).toBeFunction();
    lock.release();
  }, 60_000);

  test('releasing lets the next acquirer through — a redeploy is not blocked', () => {
    const directory = tempDir();
    const first = claim(directory);
    first.release();

    const second = claim(directory);
    second.release();
    // Idempotent: shutdown can call it twice (the normal path and the
    // forced-exit timer).
    expect(() => second.release()).not.toThrow();
  });

  test('two directories are independent locks', () => {
    const a = claim(tempDir());
    const b = claim(tempDir());
    a.release();
    b.release();
  });

  test('a second acquirer in the same process loses too — a worker thread opens its own connection', () => {
    const directory = tempDir();
    const first = claim(directory);
    try {
      expect(tryAcquireWriterLock(directory)).toBeNull();
    } finally {
      first.release();
    }
  });

  test('a directory the lock cannot be created in still fails loudly, not as a lost election', () => {
    const directory = tempDir();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a temp directory this test created
    mkdirSync(path.join(directory, '.writer-lock.db'));

    expect(() => tryAcquireWriterLock(directory)).toThrow();
  });
});
