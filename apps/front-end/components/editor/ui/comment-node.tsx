'use client';

import type { TCommentText } from 'platejs';
import type { PlateLeafProps } from 'platejs/react';

import { getCommentCount } from '@platejs/comment';
import { PlateLeaf, useEditorPlugin, usePluginOption } from 'platejs/react';
import { cn } from '@/lib/utils';

import { commentPlugin } from '@/components/editor/plugins/comment-kit';

export function CommentLeaf(props: PlateLeafProps<TCommentText>) {
  const { api, setOption } = useEditorPlugin(commentPlugin);
  const hoverId = usePluginOption(commentPlugin, 'hoverId');
  const activeId = usePluginOption(commentPlugin, 'activeId');

  const currentId = api.comment.nodeId(props.leaf) ?? null;
  const isOverlapping = getCommentCount(props.leaf) > 1;
  const isFocused =
    currentId !== null && (activeId === currentId || hoverId === currentId);

  return (
    <PlateLeaf
      {...props}
      attributes={{
        ...props.attributes,
        onClick: () => setOption('activeId', currentId),
        onMouseEnter: () => setOption('hoverId', currentId),
        onMouseLeave: () => setOption('hoverId', null),
      }}
      className={cn(
        'border-b-2 border-b-highlight/[.36] bg-highlight/[.13] transition-colors duration-200',
        isOverlapping && 'border-b-highlight/[.7] bg-highlight/25',
        isFocused && 'border-b-highlight',
        isFocused && (isOverlapping ? 'bg-highlight/45' : 'bg-highlight/25')
      )}
    />
  );
}
