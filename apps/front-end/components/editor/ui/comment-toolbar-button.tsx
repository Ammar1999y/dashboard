'use client';

import { useEditorRef } from 'platejs/react';

import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';
import { commentPlugin } from '@/components/editor/plugins/comment-kit';

export function CommentToolbarButton() {
  const editor = useEditorRef();

  return (
    <ToolbarButton
      data-plate-prevent-overlay
      onClick={() => {
        editor.getTransforms(commentPlugin).comment.setDraft();
      }}
      tooltip='تعليق'
    >
      <Icon icon='solar:chat-square-line-linear' />
    </ToolbarButton>
  );
}
