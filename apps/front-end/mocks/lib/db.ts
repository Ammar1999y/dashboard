import type { EntityID } from '@app/shared/types';

import { SEED_VERSION } from '../seed';

const MOCK_KEY_PREFIX = 'mock-api:';
const PREFIX = `${MOCK_KEY_PREFIX}v${SEED_VERSION}:`;

const mockKeys = () =>
  Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.key(i)
  ).filter((key): key is string => !!key?.startsWith(MOCK_KEY_PREFIX));

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Blocked storage leaves the mocks in memory, for this page load only; a
 * storage that works but refuses one write (a full quota) fails that request.
 * Rows saved under another `SEED_VERSION` are never read again, so they go.
 */
const storageAvailable = (() => {
  try {
    localStorage.setItem(`${PREFIX}probe`, '');
    localStorage.removeItem(`${PREFIX}probe`);
    for (const key of mockKeys())
      if (!key.startsWith(PREFIX)) localStorage.removeItem(key);
    return true;
  } catch {
    console.warn('[mock api] no localStorage: changes last until a reload');
    return false;
  }
})();

function write(key: string, value: unknown) {
  if (!storageAvailable) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (error) {
    throw new Error(`[mock api] could not save "${key}" to localStorage`, {
      cause: error,
    });
  }
}

/**
 * Each tab holds its own copy of what it read. Another tab's write drops it,
 * so the next request reads the saved rows instead of overwriting them.
 */
const invalidators = new Map<string, () => void>();
export function watchOtherTabs() {
  // `window` types the event: `globalThis` here is Bun's untyped EventTarget.
  // eslint-disable-next-line unicorn/prefer-global-this
  window.addEventListener('storage', ({ key }) => {
    if (key === null) for (const drop of invalidators.values()) drop();
    else if (key.startsWith(PREFIX))
      invalidators.get(key.slice(PREFIX.length))?.();
  });
}

export function clearMockData() {
  try {
    for (const key of mockKeys()) localStorage.removeItem(key);
  } catch {
    // Nothing persisted, nothing to clear.
  }
  for (const drop of invalidators.values()) drop();
}

export const now = () => new Date().toISOString();

export interface Table<T extends { id: EntityID }> {
  all: () => T[];
  find: (id: EntityID) => T | undefined;
  insert: (row: T) => T;
  update: (id: EntityID, patch: Partial<T>) => T | undefined;
  remove: (id: EntityID) => boolean;
}

// `localStorage` is this app's own mock data, written only by `table` and
// `singleton`, so what it holds is read back as the type it was written as.
export function table<T extends { id: EntityID }>(
  name: string,
  seed: () => T[]
): Table<T> {
  let rows: T[] | undefined;
  invalidators.set(name, () => {
    rows = undefined;
  });
  // A refused write fails the request and drops the copy, so nothing reads as
  // saved that is not.
  const save = () => {
    try {
      write(name, rows);
    } catch (error) {
      rows = undefined;
      throw error;
    }
  };
  const load = (): T[] => {
    if (rows) return rows;
    const stored = read(name);
    if (Array.isArray(stored)) {
      rows = stored as T[];
    } else {
      rows = seed();
      save();
    }
    return rows;
  };

  return {
    all: () => load(),
    find: (id) => load().find((row) => row.id === id),
    insert: (row) => {
      load().unshift(row);
      save();
      return row;
    },
    update: (id, patch) => {
      const list = load();
      const index = list.findIndex((row) => row.id === id);
      if (index === -1) return;
      const next = { ...list[index], ...patch, id };
      list[index] = next;
      save();
      return next;
    },
    remove: (id) => {
      const list = load();
      const index = list.findIndex((row) => row.id === id);
      if (index === -1) return false;
      list.splice(index, 1);
      save();
      return true;
    },
  };
}

export interface Singleton<T> {
  get: () => T;
  set: (value: T) => void;
}

export function singleton<T>(name: string, seed: () => T): Singleton<T> {
  let value: { current: T } | undefined;
  invalidators.set(name, () => {
    value = undefined;
  });
  const save = (next: T) => {
    try {
      write(name, next);
    } catch (error) {
      value = undefined;
      throw error;
    }
  };
  const load = () => {
    if (value) return value;
    const stored = read(name);
    if (stored === undefined) {
      value = { current: seed() };
      save(value.current);
    } else {
      value = { current: stored as T };
    }
    return value;
  };

  return {
    get: () => load().current,
    set: (next) => {
      save(next);
      load().current = next;
    },
  };
}
