'use client';

import type { PlateEditor } from 'platejs/react';

import * as React from 'react';

import { MarkdownPlugin } from '@platejs/markdown';
import { useEditorRef } from 'platejs/react';
import { useFilePicker } from 'use-file-picker';
import { toastError } from '@/lib/toast-error';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';
import { deserializeEditorHtml } from '@/components/editor/export';

/**
 * `useFilePicker`'s config is a union discriminated on `readAs`/`readFilesContent`,
 * so omitting those leaves `onFilesSelected` without a contextual type. Only
 * `plainFiles` is read here, and it is absent on the error branch.
 */
type PickedFiles = { plainFiles?: File[] };

const PARSERS = {
  html: deserializeEditorHtml,
  markdown: (editor: PlateEditor, text: string) =>
    editor.getApi(MarkdownPlugin).markdown.deserialize(text),
};

function useImportPicker(accept: string[], parse: keyof typeof PARSERS) {
  const editor = useEditorRef();
  return useFilePicker({
    accept,
    multiple: false,
    // Read below, once: the picker would otherwise read it first.
    readFilesContent: false,
    onFilesSelected: ({ plainFiles }: PickedFiles) => {
      const file = plainFiles?.[0];
      if (!file) return;
      file
        .text()
        .then((text) => editor.tf.insertNodes(PARSERS[parse](editor, text)))
        .catch(toastError);
    },
  }).openFilePicker;
}

export function ImportToolbarButton() {
  const [open, setOpen] = React.useState(false);
  const openHtml = useImportPicker(['text/html', '.html', '.htm'], 'html');
  const openMarkdown = useImportPicker(['.md', '.mdx'], 'markdown');

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='استيراد'>
          <Icon icon='solar:upload-minimalistic-linear' className='size-4' />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start'>
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={openHtml}>
            استيراد من HTML
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openMarkdown}>
            استيراد من Markdown
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
