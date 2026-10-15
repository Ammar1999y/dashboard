import type { Mode } from './store';
import type {
  LibraryFilters,
  RecentDays,
  SizePreset,
} from '@/lib/media/listing';
import type { BucketType, FileKind } from '@app/shared/validation/enums';
import type { ReactNode } from 'react';

import { memo, useCallback } from 'react';

import { BUCKET_TYPES, FILE_KINDS } from '@app/shared/validation/enums';
import { ALLOWED_MIME_TYPES } from '@app/shared/validation/media-types';
import { useCapabilities } from '@/lib/media/capabilities';
import {
  filterCount,
  NO_FILTERS,
  RECENT_DAYS,
  recentFrom,
  SIZE_PRESETS,
} from '@/lib/media/listing';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { BUCKET_LABELS, KIND_LABELS, mimeLabel } from './format';
import { setFilters, setMode } from './navigation';
import { getBrowser, useBrowser } from './store';

const SIZE_LABELS: Readonly<Record<SizePreset, string>> = {
  lt100k: 'أقل من 100 KB',
  lt500k: 'أقل من 500 KB',
  gt500k: 'أكبر من 500 KB',
  gt1m: 'أكبر من 1 MB',
  gt5m: 'أكبر من 5 MB',
};

const MODES: readonly {
  mode: Mode;
  label: string;
  icon: 'lucide:folder-open' | 'lucide:file-image' | 'lucide:file-question';
}[] = [
  { mode: 'folders', label: 'المجلدات', icon: 'lucide:folder-open' },
  { mode: 'all', label: 'كل الملفات', icon: 'lucide:file-image' },
  { mode: 'unfiled', label: 'غير مصنّفة', icon: 'lucide:file-question' },
];

/** One filter value; choosing the chosen one again clears it. */
function toggled<K extends keyof LibraryFilters>(
  filters: LibraryFilters,
  key: K,
  value: LibraryFilters[K]
): LibraryFilters {
  const { [key]: current, ...rest } = filters;
  return current === value ? rest : { ...rest, [key]: value };
}

const Chip = memo(
  ({
    on,
    onPress,
    children,
  }: {
    on: boolean;
    onPress: () => void;
    children: ReactNode;
  }) => (
    <button
      type='button'
      aria-pressed={on}
      onClick={onPress}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md border bg-muted px-2.5 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3',
        on && 'border-primary bg-primary/15 text-primary hover:text-primary'
      )}
    >
      {children}
    </button>
  )
);

Chip.displayName = 'Chip';

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className='mb-2.5'>
    <h6 className='mb-1.5 text-xs font-medium text-muted-foreground'>
      {title}
    </h6>
    <div className='flex flex-wrap gap-1.5'>{children}</div>
  </div>
);

type ChipValue =
  | { filter: 'kind'; value: FileKind }
  | { filter: 'bucketType'; value: BucketType }
  | { filter: 'mimeType'; value: string }
  | { filter: 'size'; value: SizePreset };

function toggledValue(filters: LibraryFilters, chip: ChipValue) {
  switch (chip.filter) {
    case 'kind': {
      return toggled(filters, 'kind', chip.value);
    }
    case 'bucketType': {
      return toggled(filters, 'bucketType', chip.value);
    }
    case 'mimeType': {
      return toggled(filters, 'mimeType', chip.value);
    }
    case 'size': {
      return toggled(filters, 'size', chip.value);
    }
  }
}

/** A chip bound to one value of one filter. */
const ValueChip = memo(
  ({ children, ...chip }: ChipValue & { children: ReactNode }) => {
    const on = useBrowser((s) => s.filters[chip.filter] === chip.value);
    const press = () => setFilters(toggledValue(getBrowser().filters, chip));
    return (
      <Chip on={on} onPress={press}>
        {children}
      </Chip>
    );
  }
);

ValueChip.displayName = 'ValueChip';

const RecentChip = memo(({ days }: { days: RecentDays }) => {
  const on = useBrowser((s) => s.filters.since?.days === days);
  const press = useCallback(() => {
    const { since, ...rest } = getBrowser().filters;
    setFilters(
      since?.days === days
        ? rest
        : { ...rest, since: { days, from: recentFrom(days, Date.now()) } }
    );
  }, [days]);
  return (
    <Chip on={on} onPress={press}>
      آخر {days} يوماً
    </Chip>
  );
});

RecentChip.displayName = 'RecentChip';

const ModeSwitch = memo(() => {
  const mode = useBrowser((s) => s.mode);
  const choose = useCallback((value: string) => {
    const found = MODES.find((option) => option.mode === value);
    if (found) setMode(found.mode);
  }, []);
  return (
    <Tabs value={mode} onValueChange={choose}>
      <TabsList className='flex w-full'>
        {MODES.map(({ mode: value, label, icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            className='text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'
          >
            <Icon icon={icon} />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
});

ModeSwitch.displayName = 'ModeSwitch';

const clearAll = () => setFilters(NO_FILTERS);

/** Only where both buckets exist: with one, the filter matches all or nothing. */
const VisibilityGroup = memo(() => {
  const visibilities = useCapabilities((s) => s.visibilities);
  if (visibilities.length < 2) return null;
  return (
    <Group title='الرؤية'>
      {BUCKET_TYPES.filter((bucket) => visibilities.includes(bucket)).map(
        (bucket) => (
          <ValueChip key={bucket} filter='bucketType' value={bucket}>
            <Icon icon={bucket === 'public' ? 'lucide:globe' : 'lucide:lock'} />
            {BUCKET_LABELS[bucket]}
          </ValueChip>
        )
      )}
    </Group>
  );
});

VisibilityGroup.displayName = 'VisibilityGroup';

const FilterContent = memo(() => (
  <>
    <div className='mb-2 flex items-center justify-between'>
      <b className='flex items-center gap-1.5 font-medium'>
        <Icon icon='lucide:list-filter' className='size-4' />
        تصفية الملفات
      </b>
      <Button variant='link' size='none' className='text-xs' onClick={clearAll}>
        إزالة الكل
      </Button>
    </div>
    <div className='mb-2.5'>
      <h6 className='mb-1.5 text-xs font-medium text-muted-foreground'>
        العرض
      </h6>
      <ModeSwitch />
    </div>
    <Group title='النوع'>
      {FILE_KINDS.map((kind) => (
        <ValueChip key={kind} filter='kind' value={kind}>
          {KIND_LABELS[kind]}
        </ValueChip>
      ))}
    </Group>
    <VisibilityGroup />
    <Group title='الصيغة'>
      {ALLOWED_MIME_TYPES.map((mime) => (
        <ValueChip key={mime} filter='mimeType' value={mime}>
          <bdi dir='ltr'>{mimeLabel(mime)}</bdi>
        </ValueChip>
      ))}
    </Group>
    <Group title='الحجم'>
      {(Object.keys(SIZE_PRESETS) as SizePreset[]).map((preset) => (
        <ValueChip key={preset} filter='size' value={preset}>
          {SIZE_LABELS[preset]}
        </ValueChip>
      ))}
    </Group>
    <Group title='التاريخ'>
      {RECENT_DAYS.map((days) => (
        <RecentChip key={days} days={days} />
      ))}
    </Group>
  </>
));

FilterContent.displayName = 'FilterContent';

/** The filter button, its count when filters apply, and the panel it opens. */
export const FilterButton = memo(() => {
  const count = useBrowser((s) => filterCount(s.filters));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className={cn(
            'h-[26px] px-2.5 text-xs',
            count > 0 && 'border-primary bg-primary/15 text-primary'
          )}
        >
          <Icon icon='lucide:list-filter' className='size-4' />
          <span className='group-data-[width=compact]/fm:hidden'>تصفية</span>
          {count > 0 && (
            <b className='grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-xs leading-none text-primary-foreground'>
              {count}
            </b>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[300px] p-2.5 text-sm'>
        <FilterContent />
      </PopoverContent>
    </Popover>
  );
});

FilterButton.displayName = 'FilterButton';
