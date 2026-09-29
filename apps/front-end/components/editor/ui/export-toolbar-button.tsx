'use client';

import type { PlateEditor } from 'platejs/react';

import * as React from 'react';

import { useEditorRef } from 'platejs/react';

import { toastError } from '@/utils/mutation';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';
import {
  downloadEditorHtml,
  downloadEditorImage,
  downloadEditorMarkdown,
  downloadEditorPdf,
  printEditorDocument,
} from '@/components/editor/export';

const contentDir = (editor: PlateEditor) =>
  editor.api.toDOMNode(editor)?.dir === 'rtl' ? 'rtl' : 'ltr';

async function runExport(
  run: (editor: PlateEditor) => Promise<void> | void,
  editor: PlateEditor
) {
  try {
    await run(editor);
  } catch (error) {
    toastError(error);
  }
}

const EXPORTS: {
  label: string;
  run: (editor: PlateEditor) => Promise<void> | void;
}[] = [
  {
    label: 'تصدير كـ HTML',
    run: (editor) =>
      downloadEditorHtml(editor.children, { dir: contentDir(editor) }),
  },
  {
    label: 'تصدير كـ PDF',
    run: (editor) =>
      downloadEditorPdf(editor.children, { dir: contentDir(editor) }),
  },
  {
    label: 'تصدير كصورة',
    run: (editor) =>
      downloadEditorImage(editor.children, { dir: contentDir(editor) }),
  },
  {
    label: 'تصدير كـ Markdown',
    run: (editor) => downloadEditorMarkdown(editor.children),
  },
  {
    label: 'طباعة',
    run: (editor) =>
      printEditorDocument(editor.children, { dir: contentDir(editor) }),
  },
];

export function ExportToolbarButton() {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='تصدير'>
          <Icon icon='solar:download-minimalistic-linear' className='size-4' />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start'>
        <DropdownMenuGroup>
          {EXPORTS.map(({ label, run }) => (
            <DropdownMenuItem
              key={label}
              onSelect={() => void runExport(run, editor)}
            >
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
