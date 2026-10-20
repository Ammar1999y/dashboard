import type { LabTableStatus } from './checks';
import type { LabRow } from './fake-server';
import type { LabEnvironment, LabEvent } from './types';
import type { DataTableFeatures } from '@/components/ui/data-table';
import type { ColumnStore } from '@/components/ui/data-table/store/column-store';
import type { Table } from '@tanstack/react-table';

import { create } from 'zustand';

interface LabState {
  table: Table<DataTableFeatures, LabRow> | null;
  store: ColumnStore | null;
  root: HTMLElement | null;
  status: LabTableStatus;
  mountKey: number;
  events: LabEvent[];
  running: string | null;
  hidePassive: boolean;
  env: LabEnvironment | null;
}

export const useLab = create<LabState>(() => ({
  table: null,
  store: null,
  root: null,
  status: { isLoading: true, hasError: false, dataLength: 0, pageCount: 1 },
  mountKey: 0,
  events: [],
  running: null,
  hidePassive: true,
  env: null,
}));

export const LAB_STORAGE_KEY = 'data-table-lab';
export const LAB_PROFILER_ID = 'data-table-lab';
