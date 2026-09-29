import type { TCodeBlockElement } from 'platejs';
import type { SlateElementProps, SlateLeafProps } from 'platejs/static';

import { SlateElement, SlateLeaf } from 'platejs/static';

import {
  CODE_BLOCK_CLASS,
  CODE_BLOCK_PRE_CLASS,
  CODE_BLOCK_SURFACE_CLASS,
} from '@/components/editor/styles';

export function CodeBlockElementStatic(
  props: SlateElementProps<TCodeBlockElement>
) {
  return (
    <SlateElement className={CODE_BLOCK_CLASS} {...props}>
      <div className={CODE_BLOCK_SURFACE_CLASS}>
        <pre className={CODE_BLOCK_PRE_CLASS}>
          <code>{props.children}</code>
        </pre>
      </div>
    </SlateElement>
  );
}

export function CodeLineElementStatic(props: SlateElementProps) {
  return <SlateElement {...props} />;
}

export function CodeSyntaxLeafStatic(props: SlateLeafProps) {
  const { className } = props.leaf;

  return (
    <SlateLeaf
      className={typeof className === 'string' ? className : undefined}
      {...props}
    />
  );
}
