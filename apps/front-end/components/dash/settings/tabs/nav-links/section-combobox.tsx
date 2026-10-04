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
import { MSG_LOADING, MSG_NO_RESULTS } from '@/constants/messages';
import { useQueryData } from '@/lib/api/query';

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
} from '@/components/ui/autocomplete/combobox';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import FormField from '@/components/form/form-field';

import { sectionEntity } from '../../../sections/entity';

const LINK_ICON = <Icon icon='solar:link-linear' className='size-4' />;

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
    const isSelectingRef = useRef(false);

    useEffect(() => {
      setInputValue(field.value || '');
    }, [field.value]);

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
        isSelectingRef.current = true;
        const newValue = value ? `#${value}` : '';
        setInputValue(newValue);
        field.onChange(newValue);
      },
      [field]
    );

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
            icon={LINK_ICON}
            disabled={field.disabled}
            onBlur={field.onBlur}
            ref={field.ref}
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
    const {
      data: sections,
      error,
      refetch,
    } = useQueryData<SectionClient[]>({
      queryKey: sectionEntity.keys.list,
      href: sectionEntity.href,
    });

    const filteredSections = useMemo(() => {
      if (!sections) return [];

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
    // Nothing to suggest leaves the field a plain input for an external link.
    if (sections && filteredSections.length === 0) return null;
    return (
      <ComboboxContent data-lenis-prevent>
        {sections && (
          <>
            <ComboboxEmpty className='flex h-20 items-center justify-center text-sm font-semibold'>
              {MSG_NO_RESULTS}
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
        {!sections && error && (
          <ErrorState
            error={error}
            refetch={refetch}
            className='m-1 py-4 text-sm'
          />
        )}
        {!sections && !error && (
          <div className='flex h-20 items-center justify-center text-sm font-semibold'>
            {MSG_LOADING}
          </div>
        )}
      </ComboboxContent>
    );
  }
);

SectionComboboxContent.displayName = 'SectionComboboxContent';
