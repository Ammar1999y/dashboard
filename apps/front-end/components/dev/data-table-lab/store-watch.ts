import type { ColumnStore } from '@/components/ui/data-table/store/column-store';
import type { QueryClient } from '@tanstack/react-query';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { LAB_QUERY_KEY } from './fake-server';
import { useLab } from './lab-store';

const COLUMN_SLICES = [
  'columnOrder',
  'columnVisibility',
  'columnPinning',
  'columnSizing',
  'columnSizingInfo',
] as const;

const TABLE_URL_KEYS = [
  'page',
  'perPage',
  'sort',
  'filters',
  'joinOperator',
  'search',
  'tableKey',
] as const;

// Each table instance owns its column store, so the watch moves with it.
function watchColumnStore(onWrite: (label: string) => void): () => void {
  const watch = (store: ColumnStore | null) =>
    store?.subscribe((state, previous) => {
      const changed = COLUMN_SLICES.filter(
        (key) => state[key] !== previous[key]
      );
      onWrite(
        changed.length === 0
          ? 'columnStore (unchanged)'
          : `columnStore.${changed.join('+')}`
      );
    });
  let unwatch = watch(useLab.getState().store);
  const unsubscribe = useLab.subscribe((state, previous) => {
    if (state.store === previous.store) return;
    unwatch?.();
    unwatch = watch(state.store);
  });
  return () => {
    unsubscribe();
    unwatch?.();
  };
}

/**
 * Reports every write to the table's stores and every cache action of the
 * lab query, so an event can show what triggered the renders it recorded.
 */
export function watchStores(
  queryClient: QueryClient,
  onWrite: (label: string) => void
): () => void {
  const unsubscribes = [
    watchColumnStore(onWrite),
    useDataTableStore.subscribe((state, previous) => {
      const changed = TABLE_URL_KEYS.filter(
        (key) => state[key] !== previous[key]
      );
      onWrite(
        changed.length === 0
          ? 'urlState (unchanged)'
          : `urlState.${changed.join('+')}`
      );
    }),
    queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== LAB_QUERY_KEY || event.type !== 'updated')
        return;
      onWrite(`query ${event.action.type}`);
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
