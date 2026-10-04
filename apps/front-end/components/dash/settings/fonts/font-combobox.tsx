import { memo, useCallback, useId, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { CustomError } from '@app/shared/error-class';
import { MSG_FETCH_ERROR } from '@app/shared/messages/common';
import { MSG_LOADING, MSG_NO_RESULTS } from '@/constants/messages';
import { fetchOnline, invalidResponse } from '@/lib/api/fetch';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const GOOGLE_FONTS_KEY = ['google-fonts'];
const GOOGLE_FONTS_PATH = '/js/google-fonts.json';

const googleFontsSchema = z.object({ data: z.array(z.string()) });

async function fetchGoogleFonts({ signal }: { signal: AbortSignal }) {
  const response = await fetchOnline(GOOGLE_FONTS_PATH, { signal });
  if (!response.ok) throw new CustomError(MSG_FETCH_ERROR, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
  }
  const parsed = googleFontsSchema.safeParse(body);
  if (!parsed.success) throw invalidResponse();
  return parsed.data.data;
}

interface FontComboboxProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  languageName?: string;
}

const FontCombobox = memo(
  ({ value, onChange, disabled, languageName }: FontComboboxProps) => {
    const id = useId();
    const [open, setOpen] = useState(false);

    const handleSelect = useCallback(
      (fontName: string) => {
        const newValue = fontName === value ? null : fontName;
        onChange(newValue);
        setOpen(false);
      },
      [value, onChange]
    );

    return (
      <>
        <Label
          htmlFor={id}
          title={`نوع الخط${languageName ? ` (${languageName})` : ''}`}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={id}
              variant='outline'
              role='combobox'
              aria-expanded={open}
              disabled={disabled}
              className='relative h-input w-full justify-between bg-input px-4 py-3 shadow-none hover:shadow-md dark:bg-input/30 dark:hover:bg-input/50'
            >
              <FontLabel selectedValue={value} />
              <Icon
                icon='solar:alt-arrow-down-linear'
                className='absolute top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground/80 ltr:right-3 rtl:left-3'
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent className='w-[--radix-popper-anchor-width] p-0'>
            <Content
              selectedValue={value}
              onSelect={handleSelect}
              isOpen={open}
            />
          </PopoverContent>
        </Popover>
      </>
    );
  }
);

FontCombobox.displayName = 'FontCombobox';

interface FontLabelProps {
  selectedValue: string | null | undefined;
}

const FontLabel = memo(({ selectedValue }: FontLabelProps) => (
  <span className={cn('truncate', !selectedValue && 'text-muted-foreground')}>
    {selectedValue || 'اختر الخط'}
  </span>
));

FontLabel.displayName = 'FontLabel';

interface ContentProps {
  selectedValue: string | null | undefined;
  onSelect: (value: string) => void;
  isOpen: boolean;
}

const Content = memo(({ selectedValue, onSelect, isOpen }: ContentProps) => {
  const {
    data: fonts,
    error,
    refetch,
  } = useQuery({
    queryKey: GOOGLE_FONTS_KEY,
    queryFn: fetchGoogleFonts,
    enabled: isOpen,
    // A file shipped with the build: it changes only with a deploy.
    staleTime: Infinity,
  });

  return (
    <Command data-lenis-prevent>
      <CommandInput placeholder='ابحث عن الخط...' className='h-input' />
      <CommandList>
        {fonts && (
          <>
            <CommandEmpty className='flex h-20 items-center justify-center font-semibold'>
              {MSG_NO_RESULTS}
            </CommandEmpty>
            <CommandGroup>
              {fonts.map((font) => (
                <FontItem
                  key={font}
                  fontName={font}
                  isSelected={selectedValue === font}
                  onSelect={onSelect}
                />
              ))}
            </CommandGroup>
          </>
        )}
        {!fonts && error && (
          <ErrorState
            error={error}
            refetch={refetch}
            className='m-1 py-4 text-sm'
          />
        )}
        {!fonts && !error && (
          <div className='flex h-20 items-center justify-center font-semibold'>
            {MSG_LOADING}
          </div>
        )}
      </CommandList>
    </Command>
  );
});

Content.displayName = 'FontComboboxContent';

interface FontItemProps {
  fontName: string;
  isSelected: boolean;
  onSelect: (value: string) => void;
}

const FontItem = memo(({ fontName, isSelected, onSelect }: FontItemProps) => {
  const handleSelect = useCallback(() => {
    onSelect(fontName);
  }, [fontName, onSelect]);

  return (
    <CommandItem value={fontName} onSelect={handleSelect}>
      <span className='truncate'>{fontName}</span>
      <Icon
        icon='solar:check-read-linear'
        className={cn(
          'ms-auto size-4',
          isSelected ? 'opacity-100' : 'opacity-0'
        )}
      />
    </CommandItem>
  );
});

FontItem.displayName = 'FontItem';

export { FontCombobox };
