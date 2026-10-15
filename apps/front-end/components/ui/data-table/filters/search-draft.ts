import type { DataTableStore } from '@/components/ui/data-table/store/url-store';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';

type Basis = Pick<DataTableStore, 'search' | 'filters' | 'tableKey'>;

const readBasis = (): Basis => {
  const { search, filters, tableKey } = useDataTableStore.getState();
  return { search, filters, tableKey };
};

const sameBasis = (a: Basis, b: Basis) =>
  a.search === b.search && a.filters === b.filters && a.tableKey === b.tableKey;

/**
 * What the search box has typed but not yet applied. Text waits for a pause,
 * and for the end of an IME composition; an emptied box applies at once.
 *
 * A pending term is dropped when what it was typed against changes before it
 * applies: applying it would clear the filters just applied, or search a
 * table the user has since left.
 */
export function createSearchDraft(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  // The term already applied applies nothing: applying it again would return
  // to the first page, and an empty one would clear the filters it stands
  // beside.
  const isApplied = (value: string) =>
    value === useDataTableStore.getState().search;

  const apply = (value: string) => {
    cancel();
    useDataTableStore.getState().actions.setSearch(value);
  };

  const change = (value: string) => {
    cancel();
    if (composing || isApplied(value)) return;
    if (value === '') {
      apply(value);
      return;
    }
    const basis = readBasis();
    timer = setTimeout(() => {
      timer = undefined;
      if (sameBasis(basis, readBasis())) apply(value);
    }, delayMs);
  };

  return {
    change,
    /** Enter: applies now, unless it confirms an IME composition. */
    submit: (value: string) => {
      if (composing) return;
      if (isApplied(value)) cancel();
      else apply(value);
    },
    compositionStart: () => {
      composing = true;
      cancel();
    },
    compositionEnd: (value: string) => {
      composing = false;
      change(value);
    },
    cancel,
  };
}
