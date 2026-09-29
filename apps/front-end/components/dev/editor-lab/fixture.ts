import type { Value } from 'platejs';

import { getCommentKey } from '@platejs/comment';
import { getSuggestionKey } from '@platejs/suggestion';
import { KEYS } from 'platejs';

const text = (value: string, marks: Record<string, unknown> = {}) => ({
  text: value,
  ...marks,
});
const p = (children: unknown[], props: Record<string, unknown> = {}) => ({
  type: KEYS.p,
  ...props,
  children,
});
const empty = [text('')];

const IMAGE_URL = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='240'><rect width='100%' height='100%' fill='#0d9488'/><text x='50%' y='50%' fill='#fff' font-size='40' text-anchor='middle' dominant-baseline='middle'>image</text></svg>"
)}`;

const day = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toDateString();
};

const LAB_USER_ID = 'lab-user';
const SUGGESTION_ID = 'lab-suggestion';
const COMMENT_ID = 'lab-comment';

const suggestion = (type: 'insert' | 'remove') => ({
  [KEYS.suggestion]: true,
  [getSuggestionKey(`${SUGGESTION_ID}-${type}`)]: {
    id: `${SUGGESTION_ID}-${type}`,
    createdAt: Date.now(),
    type,
    userId: LAB_USER_ID,
  },
});

/** Every block, mark and style prop the editor kits can produce. */
export function createFixture(): Value {
  return [
    { type: KEYS.h1, children: [text('Heading 1')] },
    { type: KEYS.h2, children: [text('Heading 2')] },
    { type: KEYS.h3, children: [text('Heading 3')] },
    { type: KEYS.h4, children: [text('Heading 4')] },
    { type: KEYS.h5, children: [text('Heading 5')] },
    { type: KEYS.h6, children: [text('Heading 6')] },
    { type: KEYS.toc, children: empty },
    p([
      text('Marks: '),
      text('bold', { [KEYS.bold]: true }),
      text(' '),
      text('italic', { [KEYS.italic]: true }),
      text(' '),
      text('underline', { [KEYS.underline]: true }),
      text(' '),
      text('strike', { [KEYS.strikethrough]: true }),
      text(' '),
      text('code', { [KEYS.code]: true }),
      text(' x'),
      text('2', { [KEYS.sup]: true }),
      text(' H'),
      text('2', { [KEYS.sub]: true }),
      text('O '),
      text('highlight', { [KEYS.highlight]: true }),
      text(' '),
      text('Ctrl+K', { [KEYS.kbd]: true }),
    ]),
    p([
      text('Styles: '),
      text('red', { [KEYS.color]: '#CC0000' }),
      text(' '),
      text('on yellow', { [KEYS.backgroundColor]: '#FFF2CC' }),
      text(' '),
      text('24px', { [KEYS.fontSize]: '24px' }),
      text(' '),
      text('black stays default', { [KEYS.color]: 'black' }),
    ]),
    p([
      text('Inline: a '),
      { type: KEYS.link, url: 'https://example.com', children: [text('link')] },
      text(', dates '),
      { type: KEYS.date, date: day(0), children: empty },
      text(' '),
      { type: KEYS.date, date: day(-1), children: empty },
      text(' '),
      { type: KEYS.date, date: day(1), children: empty },
      text(' '),
      { type: KEYS.date, date: 'Sat Jan 01 2000', children: empty },
      text(', one not picked '),
      { type: KEYS.date, children: empty },
      text(', math '),
      { type: KEYS.inlineEquation, texExpression: 'E = mc^2', children: empty },
      text(' and an empty one '),
      { type: KEYS.inlineEquation, texExpression: '', children: empty },
    ]),
    p([
      text('Review: '),
      text('commented text', {
        [KEYS.comment]: true,
        [getCommentKey(COMMENT_ID)]: true,
      }),
      text(', '),
      text('suggested insertion', suggestion('insert')),
      text(', '),
      text('suggested removal', suggestion('remove')),
    ]),
    p([text('Centered')], { align: 'center' }),
    p([text('End aligned')], { align: 'end' }),
    p(
      [
        text(
          'Justified text that runs long enough to wrap onto a second line, so the justification is visible across the full measure of the column.'
        ),
      ],
      { align: 'justify' }
    ),
    p([text('فقرة من اليمين إلى اليسار داخل مستند من اليسار إلى اليمين.')], {
      dir: 'rtl',
    }),
    p([text('Line height 2, repeated to wrap. '.repeat(4))], {
      lineHeight: 2,
    }),
    p([text('Indented twice')], { indent: 2 }),
    { type: KEYS.blockquote, children: [text('A blockquote.')] },
    {
      type: KEYS.callout,
      icon: '🚀',
      backgroundColor: '#E8F5E9',
      children: [text('A callout with its own icon and background.')],
    },
    { type: KEYS.hr, children: empty },
    p([text('Bulleted')], { listStyleType: 'disc', indent: 1 }),
    p([text('Nested circle')], { listStyleType: 'circle', indent: 2 }),
    p([text('Square')], { listStyleType: 'square', indent: 1 }),
    p([text('Numbered')], { listStyleType: 'decimal', indent: 1 }),
    p([text('Numbered, second')], {
      listStyleType: 'decimal',
      indent: 1,
      listStart: 2,
    }),
    p([text('Lower alpha')], { listStyleType: 'lower-alpha', indent: 1 }),
    p([text('Upper roman')], { listStyleType: 'upper-roman', indent: 1 }),
    p([text('Todo, open')], { listStyleType: KEYS.listTodo, indent: 1 }),
    p([text('Todo, done')], {
      listStyleType: KEYS.listTodo,
      indent: 1,
      checked: true,
    }),
    { type: KEYS.toggle, id: 'lab-toggle', children: [text('A toggle')] },
    p([text('Inside the toggle')], { indent: 1 }),
    {
      type: KEYS.codeBlock,
      lang: 'javascript',
      children: [
        "const answer = await ask('life');",
        'if (answer !== 42) throw new Error(`got ${answer}`);',
        '// a comment',
      ].map((line) => ({ type: KEYS.codeLine, children: [text(line)] })),
    },
    {
      type: KEYS.table,
      children: [
        {
          type: KEYS.tr,
          children: ['Header A', 'Header B', 'Header C'].map((cell) => ({
            type: KEYS.th,
            children: [p([text(cell)])],
          })),
        },
        {
          type: KEYS.tr,
          children: [
            { type: KEYS.td, colSpan: 2, children: [p([text('Merged 2')])] },
            {
              type: KEYS.td,
              background: '#FCE5CD',
              children: [p([text('Background')])],
            },
          ],
        },
        {
          type: KEYS.tr,
          children: ['1', '2', '3'].map((cell) => ({
            type: KEYS.td,
            children: [p([text(cell)])],
          })),
        },
      ],
    },
    {
      type: KEYS.columnGroup,
      children: ['70%', '30%'].map((width, index) => ({
        type: KEYS.column,
        width,
        children: [p([text(`Column ${index + 1} (${width})`)])],
      })),
    },
    {
      type: KEYS.equation,
      texExpression: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
      children: empty,
    },
    { type: KEYS.equation, texExpression: '', children: empty },
    {
      type: KEYS.img,
      url: IMAGE_URL,
      width: 320,
      align: 'center',
      caption: [p([text('A centered image')])],
      children: empty,
    },
    {
      type: KEYS.img,
      url: IMAGE_URL,
      width: 200,
      align: 'right',
      children: empty,
    },
    {
      type: KEYS.mediaEmbed,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      children: empty,
    },
    {
      type: KEYS.file,
      url: '/og.png',
      name: 'og.png',
      children: empty,
    },
    p([text('The end.')]),
  ] as Value;
}

/** Block types the fixture must render in every output. */
export const FIXTURE_TYPES = [
  KEYS.h1,
  KEYS.h2,
  KEYS.h3,
  KEYS.h4,
  KEYS.h5,
  KEYS.h6,
  KEYS.toc,
  KEYS.p,
  KEYS.blockquote,
  KEYS.callout,
  KEYS.hr,
  KEYS.toggle,
  KEYS.codeBlock,
  KEYS.table,
  KEYS.columnGroup,
  KEYS.equation,
  KEYS.img,
  KEYS.mediaEmbed,
  KEYS.file,
];

/** A long document, for scrolling and export timing. */
export function createStressFixture(blocks = 300): Value {
  const base = createFixture();
  return Array.from({ length: blocks }, (_, index) =>
    structuredClone(base[index % base.length])
  ).filter((node) => node !== undefined);
}
