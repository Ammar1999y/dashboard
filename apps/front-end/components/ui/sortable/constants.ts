import type {
  DndContextProps,
  DraggableAttributes,
  DraggableSyntheticListeners,
  UniqueIdentifier,
} from '@dnd-kit/core';
import type { SortableContextProps } from '@dnd-kit/sortable';

import { closestCenter, closestCorners } from '@dnd-kit/core';
import {
  restrictToHorizontalAxis,
  restrictToParentElement,
  restrictToVerticalAxis,
} from '@dnd-kit/modifiers';
import {
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

export const ROOT_NAME = 'Sortable';
export const CONTENT_NAME = 'SortableContent';
export const ITEM_NAME = 'SortableItem';
export const ITEM_HANDLE_NAME = 'SortableItemHandle';
export const OVERLAY_NAME = 'SortableOverlay';

export const SORTABLE_ERRORS = {
  [CONTENT_NAME]: `\`${CONTENT_NAME}\` must be used within \`${ROOT_NAME}\``,
  [ITEM_NAME]: `\`${ITEM_NAME}\` must be used within \`${CONTENT_NAME}\` or \`${OVERLAY_NAME}\``,
  [ITEM_HANDLE_NAME]: `\`${ITEM_HANDLE_NAME}\` must be used within \`${ITEM_NAME}\``,
  [OVERLAY_NAME]: `\`${OVERLAY_NAME}\` must be used within \`${ROOT_NAME}\``,
  emptyValue: `\`${ITEM_NAME}\` value cannot be an empty string`,
  getItemValueRequired: '`getItemValue` is required when items are objects',
} as const;

export const orientationConfig = {
  vertical: {
    modifiers: [restrictToVerticalAxis, restrictToParentElement],
    strategy: verticalListSortingStrategy,
    collisionDetection: closestCenter,
  },
  horizontal: {
    modifiers: [restrictToHorizontalAxis, restrictToParentElement],
    strategy: horizontalListSortingStrategy,
    collisionDetection: closestCenter,
  },
  mixed: {
    modifiers: [restrictToParentElement],
    strategy: undefined,
    collisionDetection: closestCorners,
  },
};

export type Orientation = keyof typeof orientationConfig;

export interface SortableRootContextValue<T> {
  id: string;
  items: UniqueIdentifier[];
  modifiers: DndContextProps['modifiers'];
  strategy: SortableContextProps['strategy'];
  activeId: UniqueIdentifier | null;
  setActiveId: (id: UniqueIdentifier | null) => void;
  getItemValue: (item: T) => UniqueIdentifier;
  flatCursor: boolean;
}

const EMPTY_ATTRIBUTES = {} as DraggableAttributes;
const EMPTY_LISTENERS = {} as DraggableSyntheticListeners;

export function getConditionalProps(
  condition: boolean,
  attributes: DraggableAttributes,
  listeners: DraggableSyntheticListeners | undefined
) {
  if (condition) {
    return { attributes, listeners };
  }
  return {
    attributes: EMPTY_ATTRIBUTES,
    listeners: EMPTY_LISTENERS,
  };
}
