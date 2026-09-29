'use client';

import type { ContentDir } from './styles';

import { memo, useCallback, useMemo } from 'react';

import { Plate, usePlateEditor } from 'platejs/react';

import { createEditorKit } from './editor-kit';
import { CurrentUserSync } from './plugins/discussion-kit';
import { DEFAULT_CONTENT_DIR } from './styles';
import { Editor, EditorContainer } from './ui/editor';

interface PlateEditorProps {
  /** The initial document; the editor owns it afterwards. */
  content: unknown;
  /** The document, on blur. */
  onChange: (value: unknown) => void;
  dir?: ContentDir;
}

const PlateEditor = memo(
  ({ content, onChange, dir = DEFAULT_CONTENT_DIR }: PlateEditorProps) => {
    const value = useMemo(
      () => (Array.isArray(content) ? content : []),
      [content]
    );
    const editor = usePlateEditor({ plugins: createEditorKit(), value });
    const handleBlur = useCallback(
      () => onChange(editor.children),
      [editor, onChange]
    );

    return (
      <Plate editor={editor}>
        <CurrentUserSync />
        <EditorContainer>
          <Editor dir={dir} onBlur={handleBlur} />
        </EditorContainer>
      </Plate>
    );
  }
);

PlateEditor.displayName = 'PlateEditor';
export default PlateEditor;
