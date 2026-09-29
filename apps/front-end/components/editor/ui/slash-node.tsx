'use client';

import type { TComboboxInputElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { KEYS } from 'platejs';
import { PlateElement } from 'platejs/react';

import { NO_RESULTS_MESSAGE } from '@/utils/ui-messages';

import { Icon } from '@/components/ui/icon';
import { INSERT_GROUPS } from '@/components/editor/block-types';
import { insertItem } from '@/components/editor/transforms';

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from './inline-combobox';

const SLASH_GROUPS = INSERT_GROUPS.map((group) => ({
  ...group,
  items: group.items.filter((item) => item.value !== KEYS.link),
}));

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const { editor, element } = props;

  return (
    <PlateElement {...props} as='span'>
      <InlineCombobox element={element} trigger='/'>
        <InlineComboboxInput />

        <InlineComboboxContent>
          <InlineComboboxEmpty>{NO_RESULTS_MESSAGE}</InlineComboboxEmpty>

          {SLASH_GROUPS.map((group) => (
            <InlineComboboxGroup key={group.label}>
              <InlineComboboxGroupLabel>{group.label}</InlineComboboxGroupLabel>

              {group.items.map((item) => (
                <InlineComboboxItem
                  focusEditor={item.focusEditor}
                  group={group.label}
                  key={item.value}
                  keywords={item.keywords}
                  label={item.label}
                  onClick={() => insertItem(editor, item, { upsert: true })}
                  value={item.value}
                >
                  <div className='me-2 text-muted-foreground'>
                    <Icon icon={item.icon} className={item.iconClassName} />
                  </div>
                  {item.label}
                </InlineComboboxItem>
              ))}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  );
}
