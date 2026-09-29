import type { ChangeEvent, KeyboardEvent } from 'react';

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

const DEBOUNCE_MS = 800;

const DataTableSearch = memo(() => {
  const search = useDataTableStore((s) => s.search);
  const [localValue, setLocalValue] = useState(search);
  const [syncedSearch, setSyncedSearch] = useState(search);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The store's search also changes from outside (applying filters clears
  // it). Adopted during render, not in an effect, so the input never shows a
  // frame of the old text.
  if (search !== syncedSearch) {
    setSyncedSearch(search);
    setLocalValue(search);
  }

  // A pending commit would overwrite that outside change — and committing a
  // search clears the filters — so any change to `search` cancels it.
  useEffect(() => () => clearTimeout(timerRef.current), [search]);

  const commit = useCallback((value: string) => {
    clearTimeout(timerRef.current);
    useDataTableStore.getState().actions.setSearch(value);
  }, []);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const { value } = e.currentTarget;
      setLocalValue(value);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => commit(value), DEBOUNCE_MS);
    },
    [commit]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !composingRef.current)
        commit(e.currentTarget.value);
    },
    [commit]
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  return (
    <div className='relative'>
      <Icon
        icon='solar:magnifer-linear'
        className='pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5'
      />
      <Input
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        dir='auto'
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder='...البحث السريع'
        className='!h-9 border-0 bg-transparent ps-8 placeholder:!text-right'
      />
    </div>
  );
});

DataTableSearch.displayName = 'DataTableSearch';

export { DataTableSearch };
