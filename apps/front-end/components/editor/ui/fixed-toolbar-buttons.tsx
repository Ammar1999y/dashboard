'use client';

import type { MediaType } from '@/components/editor/media-config';

import { memo, useCallback, useState } from 'react';

import { KEYS } from 'platejs';
import { useEditorReadOnly } from 'platejs/react';
import { createDialog } from '@/lib/dialogs';

import { Icon } from '@/components/ui/icon';
import { ToolbarButton, ToolbarGroup } from '@/components/ui/toolbar';
import { mediaConfig } from '@/components/editor/media-config';

import { AlignToolbarButton } from './align-toolbar-button';
import { ClearFormattingToolbarButton } from './clear-formatting-toolbar-button';
import { DirToolbarButton } from './dir-toolbar-button';
import { EmojiToolbarButton } from './emoji-toolbar-button';
import { ExportToolbarButton } from './export-toolbar-button';
import { FontColorToolbarButton } from './font-color-toolbar-button';
import { FontSizeToolbarButton } from './font-size-toolbar-button';
import { RedoToolbarButton, UndoToolbarButton } from './history-toolbar-button';
import { ImportToolbarButton } from './import-toolbar-button';
import {
  IndentToolbarButton,
  OutdentToolbarButton,
} from './indent-toolbar-button';
import { InsertToolbarButton } from './insert-toolbar-button';
import { LineHeightToolbarButton } from './line-height-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import {
  BulletedListToolbarButton,
  NumberedListToolbarButton,
  TodoListToolbarButton,
} from './list-toolbar-button';
import { BasicMarkButtons } from './mark-toolbar-button';
import { MediaUploadDialog } from './media-upload-dialog';
import { ModeToolbarButton } from './mode-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { TableToolbarButton } from './table-toolbar-button';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

export function FixedToolbarButtons() {
  const readOnly = useEditorReadOnly();

  return (
    <div className='flex w-full'>
      {!readOnly && (
        <>
          <ToolbarGroup>
            <UndoToolbarButton />
            <RedoToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <ExportToolbarButton />

            <ImportToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <InsertToolbarButton />
            <TurnIntoToolbarButton />
            <FontSizeToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <BasicMarkButtons />
          </ToolbarGroup>

          <ToolbarGroup>
            <FontColorToolbarButton nodeType={KEYS.color} tooltip='لون النص'>
              <Icon icon='lucide:baseline' />
            </FontColorToolbarButton>
            <FontColorToolbarButton
              nodeType={KEYS.backgroundColor}
              tooltip='لون الخلفية'
            >
              <Icon icon='lucide:paint-bucket' />
            </FontColorToolbarButton>
          </ToolbarGroup>

          <ToolbarGroup>
            <AlignToolbarButton />
            <DirToolbarButton />
            <LineHeightToolbarButton />

            <IndentToolbarButton />
            <OutdentToolbarButton />

            <BulletedListToolbarButton />
            <NumberedListToolbarButton />
            <TodoListToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <LinkToolbarButton />
            <MediaButtons />
            <TableToolbarButton />
            <EmojiToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <MoreToolbarButton />
            <ClearFormattingToolbarButton />
          </ToolbarGroup>
        </>
      )}

      <div className='grow' />

      <ToolbarGroup>
        <ModeToolbarButton />
      </ToolbarGroup>
    </div>
  );
}

const ENABLED_MEDIA_TYPES = (Object.keys(mediaConfig) as MediaType[]).filter(
  (type) => mediaConfig[type].enabled
);

const MediaToolbarButton = memo(
  ({
    type,
    onOpen,
  }: {
    type: MediaType;
    onOpen: (type: MediaType) => void;
  }) => {
    const { label, icon } = mediaConfig[type];
    const handleClick = useCallback(() => onOpen(type), [onOpen, type]);

    return (
      <ToolbarButton tooltip={label} onClick={handleClick}>
        <Icon icon={icon} />
      </ToolbarButton>
    );
  }
);
MediaToolbarButton.displayName = 'MediaToolbarButton';

function MediaButtons() {
  // One per toolbar: a module-level dialog would open in every editor on the page.
  const [dialog] = useState(() => createDialog<MediaType>());

  if (ENABLED_MEDIA_TYPES.length === 0) return null;

  return (
    <>
      {ENABLED_MEDIA_TYPES.map((type) => (
        <MediaToolbarButton key={type} type={type} onOpen={dialog.open} />
      ))}
      <MediaUploadDialog dialog={dialog} />
    </>
  );
}
