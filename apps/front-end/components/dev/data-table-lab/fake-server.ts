import type { PaginationMeta } from '@app/shared/types/api';

import { create } from 'zustand';

export interface LabRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  score: number;
  createdAt: string;
  notes: string;
}

export type LabServerMode = 'ok' | 'empty' | 'error';

interface LabServerState {
  rows: LabRow[];
  delayMs: number;
  mode: LabServerMode;
}

export interface LabQueryState {
  page: number;
  perPage: number;
  sort: { id: string; desc: boolean }[];
  filters: { id: string; value: string | string[] }[];
  search: string;
}

export interface LabPage {
  data: LabRow[];
  meta: PaginationMeta;
}

export const LAB_QUERY_KEY = 'data-table-lab';

const ROLES = ['admin', 'editor', 'viewer'];

const seedRows = (count = 57): LabRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `r${i + 1}`,
    name: `User ${String(i + 1).padStart(2, '0')}`,
    email: `user${i + 1}@lab.test`,
    role: ROLES[i % ROLES.length] ?? 'viewer',
    status: i % 4 === 0 ? 'suspended' : 'active',
    score: (i * 37) % 100,
    createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    notes: `note ${i + 1}`,
  }));

export const useLabServer = create<LabServerState>(() => ({
  rows: seedRows(),
  delayMs: 250,
  mode: 'ok',
}));

export const labServer = {
  reset: () => useLabServer.setState({ rows: seedRows(), mode: 'ok' }),
  seed: (count: number) => useLabServer.setState({ rows: seedRows(count) }),
  setMode: (mode: LabServerMode) => useLabServer.setState({ mode }),
  setDelay: (delayMs: number) => useLabServer.setState({ delayMs }),
  bumpScore: (rowId: string) =>
    useLabServer.setState((s) => ({
      rows: s.rows.map((row) =>
        row.id === rowId ? { ...row, score: row.score + 1 } : row
      ),
    })),
};

const matches = (row: LabRow, id: string, value: string | string[]) => {
  const cell = String(row[id as keyof LabRow] ?? '').toLowerCase();
  if (Array.isArray(value))
    return value.length === 0 || value.some((v) => cell === v.toLowerCase());
  return cell.includes(value.toLowerCase());
};

const compare = (a: LabRow, b: LabRow, id: string) => {
  const x = a[id as keyof LabRow];
  const y = b[id as keyof LabRow];
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y));
};

export async function fetchLabPage(
  query: LabQueryState,
  signal: AbortSignal
): Promise<LabPage> {
  const { rows, delayMs, mode } = useLabServer.getState();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
  if (mode === 'error') throw new Error('Lab: simulated server error');

  let result = mode === 'empty' ? [] : rows;
  if (query.search)
    result = result.filter((row) => matches(row, 'name', query.search));
  for (const filter of query.filters)
    result = result.filter((row) => matches(row, filter.id, filter.value));
  for (const { id, desc } of [...query.sort].reverse())
    result = [...result].sort((a, b) => compare(a, b, id) * (desc ? -1 : 1));

  const pageCount = Math.max(1, Math.ceil(result.length / query.perPage));
  const start = (query.page - 1) * query.perPage;
  return {
    data: result.slice(start, start + query.perPage),
    meta: {
      page: query.page,
      perPage: query.perPage,
      total: result.length,
      pageCount,
    },
  };
}
