'use client';

import * as React from 'react';

import { useEditorRef, useEditorSelector } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton } from '@/components/ui/toolbar';

import { ColorMenuContent } from './color-menu';

export function FontColorToolbarButton({
  children,
  nodeType,
  tooltip,
}: {
  children: React.ReactNode;
  nodeType: string;
  tooltip?: string;
}) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  const color = useEditorSelector(
    (editor) => {
      const mark = editor.api.mark(nodeType);
      return typeof mark === 'string' ? mark : undefined;
    },
    [nodeType]
  );

  const applyColor = React.useCallback(
    (value: string) => {
      setOpen(false);
      if (!editor.selection) return;
      editor.tf.select(editor.selection);
      editor.tf.focus();
      editor.tf.addMarks({ [nodeType]: value });
    },
    [editor, nodeType]
  );

  const clearColor = React.useCallback(() => {
    setOpen(false);
    if (!editor.selection) return;
    editor.tf.select(editor.selection);
    editor.tf.focus();
    editor.tf.removeMarks(nodeType);
  }, [editor, nodeType]);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton pressed={open} tooltip={tooltip}>
          {children}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start'>
        <ColorMenuContent
          color={color}
          onClear={color ? clearColor : undefined}
          onSelect={applyColor}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
