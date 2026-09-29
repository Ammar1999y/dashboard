'use client';

import { useEditorRef } from 'platejs/react';

import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';
import { clearFormatting } from '@/components/editor/transforms';

export function ClearFormattingToolbarButton() {
  const editor = useEditorRef();

  const handleClick = () => {
    clearFormatting(editor);
    editor.tf.focus();
  };

  return (
    <ToolbarButton onClick={handleClick} tooltip='مسح التنسيق'>
      <Icon icon='lucide:remove-formatting' />
    </ToolbarButton>
  );
}
