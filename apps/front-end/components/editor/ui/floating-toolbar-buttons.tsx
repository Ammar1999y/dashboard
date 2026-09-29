'use client';

import { useEditorReadOnly } from 'platejs/react';

import { ToolbarGroup } from '@/components/ui/toolbar';

import { CommentToolbarButton } from './comment-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import { BasicMarkButtons } from './mark-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { SuggestionToolbarButton } from './suggestion-toolbar-button';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

export function FloatingToolbarButtons() {
  const readOnly = useEditorReadOnly();

  return (
    <>
      {!readOnly && (
        <ToolbarGroup>
          <TurnIntoToolbarButton />
          <BasicMarkButtons />
          <LinkToolbarButton />
        </ToolbarGroup>
      )}

      <ToolbarGroup>
        <CommentToolbarButton />
        <SuggestionToolbarButton />
        {!readOnly && <MoreToolbarButton />}
      </ToolbarGroup>
    </>
  );
}
