import type { SlateEditor, TElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { BaseTocPlugin, isHeading } from '@platejs/toc';
import { KEYS, NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';

import {
  TOC_CLASS,
  tocDepth,
  tocItemVariants,
} from '@/components/editor/styles';

const HEADING_DEPTH: Record<string, number> = Object.fromEntries(
  KEYS.heading.map((type, index) => [type, index + 1])
);

// Mirrors the unexported `getHeadingList` of `@platejs/toc/react`.
function getHeadingList(editor: SlateEditor) {
  const { queryHeading } = editor.getOptions(BaseTocPlugin);
  if (queryHeading) return queryHeading(editor);

  return [
    ...editor.api.nodes<TElement>({ at: [], match: (n) => !!isHeading(n) }),
  ].flatMap(([node, path]) => {
    const title = NodeApi.string(node);
    return title ? [{ depth: HEADING_DEPTH[node.type] ?? 1, path, title }] : [];
  });
}

export function TocElementStatic(props: SlateElementProps) {
  return (
    <SlateElement {...props} className={TOC_CLASS}>
      <div contentEditable={false}>
        {getHeadingList(props.editor).map((item) => (
          <div
            className={tocItemVariants({ depth: tocDepth(item.depth) })}
            key={item.path.join('.')}
          >
            {item.title}
          </div>
        ))}
      </div>
      {props.children}
    </SlateElement>
  );
}
