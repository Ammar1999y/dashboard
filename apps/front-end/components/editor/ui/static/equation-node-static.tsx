import 'katex/dist/katex.min.css';

import type { TEquationElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { getEquationHtml } from '@platejs/math';
import { SlateElement } from 'platejs/static';

import {
  EQUATION_CLASS,
  EQUATION_OPTIONS,
  equationBlockClass,
  INLINE_EQUATION_CLASS,
  inlineEquationClass,
} from '@/components/editor/styles';

// Always filled: the published copy (published.ts) drops an empty equation.

// KaTeX escapes the TeX source and `trust: false` blocks its HTML commands.
const equationHtml = (element: TEquationElement) => ({
  __html: getEquationHtml({ element, options: EQUATION_OPTIONS }),
});

export function EquationElementStatic(
  props: SlateElementProps<TEquationElement>
) {
  return (
    <SlateElement className={EQUATION_CLASS} {...props}>
      <div className={equationBlockClass(false)}>
        <span dangerouslySetInnerHTML={equationHtml(props.element)} />
      </div>
      {props.children}
    </SlateElement>
  );
}

export function InlineEquationElementStatic(
  props: SlateElementProps<TEquationElement>
) {
  return (
    <SlateElement {...props} className={INLINE_EQUATION_CLASS}>
      <div className={inlineEquationClass(false)}>
        <span
          className='font-mono leading-none'
          dangerouslySetInnerHTML={equationHtml(props.element)}
        />
      </div>
      {props.children}
    </SlateElement>
  );
}
