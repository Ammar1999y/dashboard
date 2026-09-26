import type { EntityID } from '@/types';

// Bump when a seeded shape changes, or data saved by an older build outlives it.
const PREFIX = 'mock-api:v1:';

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the data lives until the next reload.
  }
}

export function clearMockData() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Nothing persisted, nothing to clear.
  }
}

export const now = () => new Date().toISOString();

export interface Table<T extends { id: EntityID }> {
  all: () => T[];
  find: (id: EntityID) => T | undefined;
  insert: (row: T) => T;
  update: (id: EntityID, patch: Partial<T>) => T | undefined;
  remove: (id: EntityID) => boolean;
}

export function table<T extends { id: EntityID }>(
  name: string,
  seed: () => T[]
): Table<T> {
  let rows: T[] | undefined;
  const save = () => write(name, rows);
  const load = () => {
    if (rows) return rows;
    rows = read<T[]>(name);
    if (!rows) {
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
  const load = () => (value ??= { current: read<T>(name) ?? seed() });

  return {
    get: () => load().current,
    set: (next) => {
      load().current = next;
      write(name, next);
    },
  };
}
