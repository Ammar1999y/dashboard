import type { ColumnLayout } from './column-store';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const knownIdList = (value: unknown, known: Set<string>): string[] =>
  Array.isArray(value)
    ? value.filter(
        (id): id is string => typeof id === 'string' && known.has(id)
      )
    : [];

// Sizes were once saved as `columnId-<id>` next to derived `headerId-<id>`
// entries; both shapes load, only the plain one is written.
const LEGACY_SIZE_PREFIX = 'columnId-';

function readSizing(value: unknown, known: Set<string>) {
  if (!isRecord(value)) return {};
  const sizing: Record<string, number> = {};
  for (const [key, size] of Object.entries(value)) {
    const id = key.startsWith(LEGACY_SIZE_PREFIX)
      ? key.slice(LEGACY_SIZE_PREFIX.length)
      : key;
    if (typeof size === 'number' && size > 0 && known.has(id))
      sizing[id] = size;
  }
  return sizing;
}

function readVisibility(value: unknown, known: Set<string>) {
  if (!isRecord(value)) return {};
  const visibility: Record<string, boolean> = {};
  for (const [id, visible] of Object.entries(value))
    if (typeof visible === 'boolean' && known.has(id)) visibility[id] = visible;
  return visibility;
}

/**
 * The saved layout, limited to columns the table still has. A column added
 * after the save is appended to the order instead of vanishing.
 */
export function loadLayout(
  storageKey: string,
  columnIds: string[]
): ColumnLayout | null {
  let saved: unknown;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(saved)) return null;

  const known = new Set(columnIds);
  const order = knownIdList(saved.columnOrder, known);
  const pinning = isRecord(saved.columnPinning) ? saved.columnPinning : {};

  return {
    columnOrder: [...order, ...columnIds.filter((id) => !order.includes(id))],
    columnVisibility: readVisibility(saved.columnVisibility, known),
    columnPinning: {
      left: knownIdList(pinning.left, known),
      right: knownIdList(pinning.right, known),
    },
    columnSizing: readSizing(saved.columnSizing, known),
  };
}

export function saveLayout(storageKey: string, layout: ColumnLayout | null) {
  try {
    if (layout) localStorage.setItem(storageKey, JSON.stringify(layout));
    else localStorage.removeItem(storageKey);
  } catch {
    // Storage full or unavailable: the layout just does not survive a reload.
  }
}
