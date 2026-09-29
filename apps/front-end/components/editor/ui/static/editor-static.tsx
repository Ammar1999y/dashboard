import type { ContentDir } from '@/components/editor/styles';
import type { PlateStaticProps } from 'platejs/static';

import { PlateStatic } from 'platejs/static';
import { cn } from '@/lib/utils';

import {
  DEFAULT_CONTENT_DIR,
  editorVariants,
} from '@/components/editor/styles';

import { ToggleRulesStatic } from './toggle-node-static';

export function EditorStatic({
  className,
  dir = DEFAULT_CONTENT_DIR,
  ...props
}: PlateStaticProps & { dir?: ContentDir }) {
  return (
    <>
      <ToggleRulesStatic editor={props.editor} />
      <PlateStatic
        className={cn(editorVariants({ variant: 'document' }), className)}
        dir={dir}
        {...props}
      />
    </>
  );
}
