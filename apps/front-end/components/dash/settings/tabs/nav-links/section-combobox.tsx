import type { SectionClient } from '@/types/sections';
import type { SettingsInput } from '@/utils/validation/settings';

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useController } from 'react-hook-form';

import { useQueryData } from '@/utils/query';

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
} from '@/components/ui/autocomplete/combobox';
import { Icon } from '@/components/ui/icon';
import FormField from '@/components/form/form-field';

import { sectionEntity } from '../../../sections/entity';

interface SectionLinkComboboxProps {
  index: number;
  className?: string;
}

const SectionLinkCombobox = memo(
  ({ index, className }: SectionLinkComboboxProps) => {
    const id = useId();
    const { field } = useController<SettingsInput, `navLinks.${number}.link`>({
      name: `navLinks.${index}.link`,
    });

    const [inputValue, setInputValue] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const isSelectingRef = useRef(false);

    useEffect(() => {
      setInputValue(field.value || '');
    }, [field.value]);

    const ref = useCallback(
      (el: HTMLInputElement) => {
        field.ref(el);
        if (inputRef.current !== el) {
          inputRef.current = el;
        }
      },
      [field]
    );

    const handleInputChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setInputValue(value);

        // If user is typing (not selecting from dropdown), update the field value
        if (!isSelectingRef.current) {
          field.onChange(value);
        }
        isSelectingRef.current = false;
      },
      [field]
    );

    const handleValueChange = useCallback(
      (value: string) => {
        // When selecting from dropdown, prepend # to the slug
        isSelectingRef.current = true;
        const newValue = value ? `#${value}` : '';
        setInputValue(newValue);
        field.onChange(newValue);
      },
      [field]
    );

    // Extract slug from current value (remove # if present)
    const currentSlug = useMemo(() => {
      if (field.value?.startsWith('#')) {
        return field.value.slice(1);
      }
      return '';
    }, [field.value]);

    return (
      <FormField
        name={field.name}
        label='الرابط'
        htmlFor={id}
        className={className}
      >
        <Combobox
          value={currentSlug}
          defaultValue={currentSlug}
          type='single'
          onValueChange={handleValueChange}
        >
          <ComboboxInput
            id={id}
            placeholder='قم بربط معا الاقسام، او روابط خارجيه'
            name={field.name}
            value={inputValue}
            icon={<Icon icon='solar:link-linear' className='size-4' />}
            disabled={field.disabled}
            onBlur={field.onBlur}
            ref={ref}
            onChange={handleInputChange}
          />
          <SectionComboboxContent searchValue={inputValue} />
        </Combobox>
      </FormField>
    );
  }
);

SectionLinkCombobox.displayName = 'SectionLinkCombobox';

export { SectionLinkCombobox };

interface SectionComboboxContentProps {
  searchValue: string;
}

const SectionComboboxContent = memo(
  ({ searchValue }: SectionComboboxContentProps) => {
    const { data: sections, isLoading } = useQueryData<SectionClient[]>({
      queryKey: sectionEntity.keys.list,
      href: sectionEntity.href,
    });

    // Filter sections based on search value
    const filteredSections = useMemo(() => {
      if (!sections) return [];

      // Remove # prefix if present for searching
      const search = searchValue.startsWith('#')
        ? searchValue.slice(1).toLowerCase()
        : searchValue.toLowerCase();

      if (!search) return sections;

      return sections.filter(
        (section) =>
          section.title?.toLowerCase().includes(search) ||
          section.slug?.toLowerCase().includes(search)
      );
    }, [sections, searchValue]);
    if (!isLoading && !filteredSections?.length) return null;
    return (
      <ComboboxContent data-lenis-prevent>
        {isLoading ? (
          <div className='flex h-20 items-center justify-center text-sm font-semibold'>
            جاري التحميل...
          </div>
        ) : (
          <>
            <ComboboxEmpty className='flex h-20 items-center justify-center text-sm font-semibold'>
              لا توجد أقسام مطابقة
            </ComboboxEmpty>
            {filteredSections.map((section) => (
              <ComboboxItem value={section.slug || ''} key={section.id}>
                {section.slug
                  ? `${section.title} — #${section.slug}`
                  : section.title || ''}
              </ComboboxItem>
            ))}
          </>
        )}
      </ComboboxContent>
    );
  }
);

SectionComboboxContent.displayName = 'SectionComboboxContent';
