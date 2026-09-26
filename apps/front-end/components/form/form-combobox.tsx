import type { EntityID } from '@/types';
import type { ReactNode } from 'react';

import { memo, useCallback, useId, useMemo, useState } from 'react';

import {
  CheckIcon as _CheckIcon,
  ChevronDownIcon as _ChevronDownIcon,
} from 'lucide-react';
import { useController } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { useQueryData } from '@/utils/query';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

import FormField from './form-field';

const CheckIcon = memo(_CheckIcon);
CheckIcon.displayName = 'CheckIcon';

const ChevronDownIcon = memo(_ChevronDownIcon);
ChevronDownIcon.displayName = 'ChevronDownIcon';

export interface ComboboxOption {
  id: EntityID;
  label: string;
}

const NO_OPTIONS: readonly ComboboxOption[] = [];

interface FormComboboxProps<T> {
  name: string;
  label: string;
  required?: boolean;
  placeholder: string;
  searchPlaceholder: string;
  queryKey: EntityID[];
  href: string;
  /** A module-level function: it is a memo dependency. */
  toOption: (item: T) => ComboboxOption;
  /** Offered after the server's options — a module constant. */
  extraOptions?: readonly ComboboxOption[];
  /** Pinned under the list — hoist it, or it rebuilds on every render. */
  footer?: ReactNode;
  className?: string;
}

/**
 * Single choice from a server list, stored as the option's id. Picking the
 * selected option again clears the field.
 */
function FormCombobox<T>({
  name,
  label,
  required,
  placeholder,
  searchPlaceholder,
  queryKey,
  href,
  toOption,
  extraOptions = NO_OPTIONS,
  footer,
  className,
}: FormComboboxProps<T>) {
  const id = useId();
  const {
    field: { ref, value, onChange, onBlur, disabled },
  } = useController({ name });
  const [open, setOpen] = useState(false);

  const { data, isLoading, isFetching, refetch } = useQueryData<T[]>({
    queryKey,
    href,
  });
  const options = useMemo(
    () => [...(data?.map(toOption) ?? []), ...extraOptions],
    [data, toOption, extraOptions]
  );

  const selected = typeof value === 'string' && value ? value : null;
  const selectedLabel = options.find((option) => option.id === selected)?.label;

  // Refetched on every opening: a row added in another tab — the category
  // footer opens one — is not in this tab's cache.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next && !isFetching) void refetch();
    },
    [isFetching, refetch]
  );

  const handleSelect = useCallback(
    (optionId: EntityID) => {
      onChange(optionId === selected ? null : optionId);
      setOpen(false);
    },
    [onChange, selected]
  );

  return (
    <FormField
      name={name}
      label={label}
      htmlFor={id}
      required={required}
      className={className}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            ref={ref}
            variant='outline'
            role='combobox'
            aria-expanded={open}
            disabled={disabled}
            onBlur={onBlur}
            className='relative h-input w-full justify-between bg-input px-4 py-1 shadow-none hover:shadow-md dark:bg-input/30 dark:hover:bg-input/50'
          >
            <span
              className={cn(
                'truncate',
                !selectedLabel && 'text-muted-foreground'
              )}
            >
              {selectedLabel ?? placeholder}
            </span>
            <ChevronDownIcon
              className='absolute top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground/80 ltr:right-3 rtl:left-3'
              aria-hidden='true'
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[--radix-popper-anchor-width] p-0'>
          <Command data-lenis-prevent>
            <CommandInput placeholder={searchPlaceholder} className='h-input' />
            <CommandList>
              {isLoading ? (
                <div className='flex h-20 items-center justify-center font-semibold'>
                  جاري التحميل...
                </div>
              ) : (
                <>
                  <CommandEmpty className='flex h-20 items-center justify-center font-semibold'>
                    لاتوجد نتائج
                  </CommandEmpty>
                  <CommandGroup>
                    {options.map((option) => (
                      <OptionItem
                        key={option.id}
                        option={option}
                        isSelected={option.id === selected}
                        onSelect={handleSelect}
                      />
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
            {footer}
          </Command>
        </PopoverContent>
      </Popover>
    </FormField>
  );
}

interface OptionItemProps {
  option: ComboboxOption;
  isSelected: boolean;
  onSelect: (id: EntityID) => void;
}

const OptionItem = memo(({ option, isSelected, onSelect }: OptionItemProps) => {
  const handleSelect = useCallback(
    () => onSelect(option.id),
    [option.id, onSelect]
  );

  return (
    <CommandItem value={option.label} onSelect={handleSelect}>
      <span className='truncate'>{option.label}</span>
      <CheckIcon
        className={cn(
          'ms-auto size-4',
          isSelected ? 'opacity-100' : 'opacity-0'
        )}
      />
    </CommandItem>
  );
});

OptionItem.displayName = 'FormComboboxOption';

export default FormCombobox;
