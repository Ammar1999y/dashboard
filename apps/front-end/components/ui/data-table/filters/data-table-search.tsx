import type { ChangeEvent, CompositionEvent, KeyboardEvent } from 'react';

import { memo, useCallback, useEffect, useState } from 'react';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

import { createSearchDraft } from './search-draft';

const DEBOUNCE_MS = 800;

const DataTableSearch = memo(() => {
  const search = useDataTableStore((s) => s.search);
  const filters = useDataTableStore((s) => s.filters);
  const tableKey = useDataTableStore((s) => s.tableKey);
  const [localValue, setLocalValue] = useState(search);
  const [synced, setSynced] = useState({ search, filters, tableKey });
  const [draft] = useState(() => createSearchDraft(DEBOUNCE_MS));

  // A change from outside the box (applying filters clears the search, or
  // another table opens) drops the draft, and the box shows the applied term
  // again. Adopted during render, so it never shows a frame of the old text.
  if (
    search !== synced.search ||
    filters !== synced.filters ||
    tableKey !== synced.tableKey
  ) {
    setSynced({ search, filters, tableKey });
    setLocalValue(search);
  }

  useEffect(() => draft.cancel, [draft]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const { value } = e.currentTarget;
      setLocalValue(value);
      draft.change(value);
    },
    [draft]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') draft.submit(e.currentTarget.value);
    },
    [draft]
  );

  const handleCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLInputElement>) =>
      draft.compositionEnd(e.currentTarget.value),
    [draft]
  );

  return (
    <div className='relative'>
      <Icon
        icon='solar:magnifer-linear'
        className='pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground ltr:right-2.5 rtl:left-2.5'
      />
      <Input
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        dir='auto'
        onCompositionStart={draft.compositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder='...البحث السريع'
        className='!h-9 border-0 bg-transparent placeholder:!text-right ltr:pr-8 rtl:pl-8'
      />
    </div>
  );
});

DataTableSearch.displayName = 'DataTableSearch';

export { DataTableSearch };
