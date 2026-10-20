import type { LabResult } from './lab-store';
import type { ContentDir } from '@/components/editor/styles';
import type { ThemeMode } from '@/components/theme-customizer/types';
import type { Descendant } from 'platejs';

import { MarkdownPlugin } from '@platejs/markdown';
import { createSlateEditor, KEYS, NodeApi } from 'platejs';
import { getEditorDOMFromHtmlString } from 'platejs/static';

import {
  BLOCK_TYPES,
  INSERT_GROUPS,
  THREE_COLUMNS,
  TURN_INTO_ITEMS,
} from '@/components/editor/block-types';
import { EMPTY_DATE_LABEL, formatDateLabel } from '@/components/editor/date';
import { createBaseEditorKit } from '@/components/editor/editor-base-kit';
import {
  buildEditorDocument,
  CAPTURE_WIDTH,
  captureDocument,
  deserializeEditorHtml,
  prepareCaptureDocument,
  renderEditorBody,
} from '@/components/editor/export';
import {
  CHECKED_STAMP,
  DOCUMENT_CSS_URL,
  KATEX_CSS_URL,
} from '@/components/editor/export/config';
import {
  BASE_FONT_SIZE,
  FONT_SIZE_MAX,
  parseFontSize,
  stepFontSize,
} from '@/components/editor/font-size';
import {
  EMPTY_EQUATION_LABEL,
  EMPTY_INLINE_EQUATION_LABEL,
} from '@/components/editor/labels';
import { createPublishedEditor } from '@/components/editor/published';
import { mediaAlignVariants, toMediaAlign } from '@/components/editor/styles';
import { clearFormatting } from '@/components/editor/transforms';

import { createFixture, FIXTURE_TYPES } from './fixture';
import {
  markdownRoundTrip,
  RENDER_DEMO_ID,
  TOGGLE_CONTENT,
  TOGGLE_TITLE,
  toggleDocument,
  useRenderWrites,
} from './known-issues';
import { loadFixture, useLab } from './lab-store';

type Check = (check: string, ok: boolean, detail?: string) => void;

/** Pixels that differ from the first one, which is taken as the background. */
function paintOf(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context) return { drawn: 0, background: 'a canvas with no 2D context' };
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let drawn = 0;
  for (let i = 0; i < data.length; i += 4)
    if (
      data[i] !== data[0] ||
      data[i + 1] !== data[1] ||
      data[i + 2] !== data[2] ||
      data[i + 3] !== data[3]
    )
      drawn += 1;
  return {
    drawn,
    background: `rgba(${data[0]}, ${data[1]}, ${data[2]}, ${data[3]})`,
  };
}

export interface Scenario {
  group: string;
  title: string;
  run: (check: Check) => Promise<void> | void;
}

const SETTLE_MS = 150;
const WAIT_TIMEOUT_MS = 15_000;

/**
 * Classes no stylesheet has to match: Plate's and Iconify's markers, Tailwind
 * group names, and lowlight tokens the theme leaves uncolored.
 */
const MARKER_CLASS = /^(slate-|iconify|hljs-|group$|group\/|peer$)/;

/** Only KaTeX's stylesheet names this font. */
const KATEX_FONT = 'KaTeX_Main';

const INLINE_TYPES = [KEYS.link, KEYS.date, KEYS.inlineEquation];

/** Props compared between renderings; font family differs by design. */
const LAYOUT_PROPS = [
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'text-align',
  'direction',
  'padding-top',
  'padding-bottom',
  'padding-inline-start',
  'padding-inline-end',
  'margin-top',
  'margin-bottom',
  'border-top-width',
  'border-inline-start-width',
  'text-decoration-line',
  'list-style-type',
];
const COLOR_PROPS = ['color', 'background-color'];

const PROBE_TYPES = [
  KEYS.h1,
  KEYS.h2,
  KEYS.h3,
  KEYS.h6,
  KEYS.p,
  KEYS.blockquote,
  KEYS.callout,
  KEYS.codeBlock,
  KEYS.toggle,
  KEYS.table,
  KEYS.th,
  KEYS.td,
  KEYS.columnGroup,
  KEYS.column,
];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(ready: () => boolean, what: string) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

const pane = (name: 'editor' | 'static' | 'export') =>
  document.querySelector<HTMLElement>(`[data-lab-pane="${CSS.escape(name)}"]`);

const editorRoot = () =>
  pane('editor')?.querySelector<HTMLElement>('[data-slate-editor]') ?? null;
const staticRoot = () =>
  pane('static')?.querySelector<HTMLElement>('[data-slate-editor]') ?? null;
const exportFrame = () =>
  pane('export')?.querySelector<HTMLIFrameElement>('iframe') ?? null;

/** Resolves once the export pane shows the document for the current state. */
async function exportDocument() {
  const { exportHtml } = useLab.getState();
  await waitFor(() => {
    const frame = exportFrame();
    const doc = frame?.contentDocument;
    return (
      !!doc &&
      frame?.srcdoc === exportHtml &&
      // Parsed is enough: its CSS is inline, and `complete` would also wait
      // for the embedded video player.
      doc.readyState !== 'loading' &&
      !!doc.querySelector('[data-slate-editor]')
    );
  }, 'the export pane');
  const frame = exportFrame();
  const doc = frame?.contentDocument;
  const win = frame?.contentWindow;
  if (!doc || !win) throw new Error('the export pane is gone');
  return { doc, win };
}

/** Waits for `find` to return an element, and returns it. */
async function element<T>(find: () => T | null, what: string): Promise<T> {
  await waitFor(() => find() !== null, what);
  const found = find();
  if (found === null) throw new Error(`${what} is gone`);
  return found;
}

/** Applies `patch`, waits for the export to be rebuilt, runs, then undoes it. */
async function withState(
  patch: Partial<{ dir: ContentDir }>,
  run: () => Promise<void>
) {
  const { dir: before, exportHtml } = useLab.getState();
  useLab.setState(patch);
  if (patch.dir !== before) {
    await waitFor(
      () => useLab.getState().exportHtml !== exportHtml,
      'the export'
    );
  }
  await wait(SETTLE_MS);
  try {
    await run();
  } finally {
    useLab.setState({ dir: before });
    await wait(SETTLE_MS);
  }
}

const parseBody = (html: string) =>
  getEditorDOMFromHtmlString(`<html><body>${html}</body></html>`);

// Plate classes every element `slate-<type>`, in the editor and statically.
const byType = (root: ParentNode, type: string) =>
  root.querySelector<HTMLElement>(`.slate-${CSS.escape(type)}`);

const withoutComments = (css: string) =>
  css.replaceAll(/\/\*[\s\S]*?\*\//g, '');

/** CSS escapes: a hex escape (Tailwind writes `,` as `\2c `) or a plain `\x`. */
const unescapeCss = (text: string) =>
  text.replaceAll(
    /\\([\da-f]{1,6}) ?|\\(.)/gi,
    (_, hex?: string, char?: string) =>
      hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (char ?? '')
  );

// Run on our own built stylesheet, not user input: backtracking is no risk.
// eslint-disable-next-line security/detect-unsafe-regex
const CLASS_SELECTOR = /\.((?:\\[\da-f]{1,6} ?|\\.|[\w-])+)/gi;

async function stylesheetClasses(urls: string[]) {
  const names = new Set<string>();
  for (const url of urls) {
    const css = withoutComments(await fetch(url).then((r) => r.text()));
    for (const [, raw] of css.matchAll(CLASS_SELECTOR)) {
      names.add(unescapeCss(raw ?? ''));
    }
  }
  return names;
}

function styleDiff(
  a: CSSStyleDeclaration,
  b: CSSStyleDeclaration,
  props: string[]
) {
  return props
    .filter((prop) => a.getPropertyValue(prop) !== b.getPropertyValue(prop))
    .map(
      (prop) =>
        `${prop}: ${a.getPropertyValue(prop)} ≠ ${b.getPropertyValue(prop)}`
    );
}

const topTypes = (nodes: readonly Descendant[]) =>
  nodes.flatMap((node) =>
    'type' in node && typeof node.type === 'string' ? [node.type] : []
  );

const currentTheme = (): ThemeMode =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

/** Switches the app theme with the lab's button, as a person would, then back. */
async function withTheme(theme: ThemeMode, run: () => Promise<void>) {
  const before = currentTheme();
  const pick = async (mode: ThemeMode) => {
    const button = await element(
      () =>
        document.querySelector<HTMLElement>(
          `[data-lab-theme="${CSS.escape(mode)}"]`
        ),
      `the ${mode} theme button`
    );
    button.click();
    await waitFor(
      () =>
        currentTheme() === mode &&
        useLab.getState().exportHtml.includes(`data-theme="${mode}"`),
      `the ${mode} theme`
    );
    await exportDocument();
    await wait(SETTLE_MS);
  };
  await pick(theme);
  try {
    await run();
  } finally {
    await pick(before);
  }
}

/** Relative luminance of a computed `rgb()`/`rgba()` color. */
function luminance(color: string) {
  const channels = /rgba?\(([^)]+)\)/.exec(color)?.[1]?.split(/[\s,/]+/);
  const [r = 0, g = 0, b = 0] = (channels ?? []).slice(0, 3).map((value) => {
    const c = Number(value) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type Pane = readonly [string, ParentNode, Pick<Window, 'getComputedStyle'>];

function contrastRatio(a: string, b: string) {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The renderings, each with the window its styles resolve in. */
async function panes(names = ['editor', 'static', 'export']): Promise<Pane[]> {
  const { doc, win } = await exportDocument();
  const all: Pane[] = [
    ['editor', await element(editorRoot, 'the editor'), globalThis],
    ['static', await element(staticRoot, 'the static pane'), globalThis],
    ['export', doc, win],
  ];
  return all.filter(([name]) => names.includes(name));
}

/** Clicks a static toggle open and shut, checking what it hides each time. */
function exerciseToggle(check: Check, [name, root, view]: Pane) {
  const label = root.querySelector<HTMLElement>(':scope .slate-toggle label');
  const content = [
    ...root.querySelectorAll<HTMLElement>(':scope [data-in-toggle]'),
  ].find((el) => el.textContent?.includes('Inside the toggle'));
  if (!label || !content) {
    check(`${name}: has the toggle`, false);
    return;
  }
  const shown = () => view.getComputedStyle(content).display !== 'none';
  check(`${name}: closed at first`, !shown());
  label.click();
  check(`${name}: a click opens it`, shown());
  label.click();
  check(`${name}: a second click closes it`, !shown());
}

const pxOf = (value: string) => Number(value.replace('px', ''));

/** A picked background with its text: a contrast of at least 4.5 to 1. */
function checkReadable(
  check: Check,
  label: string,
  el: HTMLElement | undefined | null,
  view: Pane[2]
) {
  if (!el) {
    check(`${label} found`, false);
    return;
  }
  const style = view.getComputedStyle(el);
  const ratio = contrastRatio(style.color, style.backgroundColor);
  check(
    `${label} contrast ≥ 4.5`,
    ratio >= 4.5,
    `${ratio.toFixed(1)}: ${style.color} on ${style.backgroundColor}`
  );
}

export const SCENARIOS: Scenario[] = [
  {
    group: 'Toolbar interaction',
    title:
      'The font-size menu stays open when its input receives focus or clicks',
    run: async (check) => {
      const input = await element(
        () =>
          pane('editor')?.querySelector<HTMLInputElement>(
            'input[aria-label="حجم الخط"]'
          ) ?? null,
        'the font-size input'
      );
      const menuIsOpen = () =>
        [
          ...document.querySelectorAll(
            '[data-slot="popover-content"][data-state="open"] button'
          ),
        ].some((button) => button.textContent === '24');
      input.focus();
      input.click();
      await wait(SETTLE_MS);
      check('opening the size input shows its presets', menuIsOpen());
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await wait(SETTLE_MS);
      check('input focus does not dismiss its presets', menuIsOpen());
      input.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })
      );
      input.click();
      await wait(SETTLE_MS);
      check('clicking the input again keeps its presets open', menuIsOpen());
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await wait(SETTLE_MS);
      check('Escape closes the presets', !menuIsOpen());
    },
  },
  {
    group: 'Rendering',
    title: 'Image and PDF captures show media URLs and expanded toggles',
    run: async (check) => {
      const html = await renderEditorBody(createFixture());
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const media = [
        ...doc.querySelectorAll<HTMLElement>('[data-export-media-url]'),
      ];
      const toggles = [
        ...doc.querySelectorAll<HTMLInputElement>(
          'input[id^="editor-toggle-"]'
        ),
      ];
      prepareCaptureDocument(doc);
      check('media cards exist', media.length > 0);
      check(
        'every card includes its URL',
        media.every((node) =>
          node.textContent?.includes(node.dataset.exportMediaUrl ?? '')
        )
      );
      check(
        'no blank players remain',
        !doc.querySelector('iframe, video, audio')
      );
      check(
        'all toggles are expanded',
        toggles.length > 0 && toggles.every((toggle) => toggle.checked)
      );
      check('ordinary links remain', !!doc.querySelector('a[href]'));
    },
  },
  {
    group: 'Rendering',
    title: 'Image capture draws the exported page',
    run: async (check) => {
      const canvas = await captureDocument(createFixture());
      check(
        'the canvas is at least the page width',
        canvas.width >= CAPTURE_WIDTH && canvas.height > 0,
        `${canvas.width}x${canvas.height}`
      );
      const page = paintOf(canvas);
      check(
        'it is not blank',
        page.drawn > 0,
        `${page.drawn} drawn pixels on ${page.background}`
      );
      const png = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      );
      check(
        'it encodes as PNG',
        (png?.size ?? 0) > 0,
        `${png?.size ?? 0} bytes`
      );

      // The control: an element of this page, not of the capture iframe. If
      // it draws and the page above does not, the iframe is what fails.
      const probe = document.createElement('div');
      probe.textContent = 'html2canvas probe';
      Object.assign(probe.style, {
        background: '#fff',
        color: '#000',
        font: '20px sans-serif',
        padding: '8px',
        width: '240px',
      });
      document.body.append(probe);
      try {
        const { default: html2canvas } = await import('html2canvas-pro');
        const control = paintOf(await html2canvas(probe));
        check(
          'it draws an element of this page (control)',
          control.drawn > 0,
          `${control.drawn} drawn pixels on ${control.background}`
        );
      } finally {
        probe.remove();
      }
    },
  },
  {
    group: 'Export stylesheet',
    title: 'Every class in the export has a rule',
    run: async (check) => {
      const html = await renderEditorBody(createFixture());
      const names = await stylesheetClasses([DOCUMENT_CSS_URL, KATEX_CSS_URL]);
      // KaTeX's own markup carries semantic classes it does not style.
      const used = new Set(
        [...(parseBody(html)?.querySelectorAll('[class]') ?? [])]
          .filter((el) => !el.parentElement?.closest('.katex'))
          .flatMap((el) => [...el.classList])
      );
      const missing = [...used].filter(
        (name) => !MARKER_CLASS.test(name) && !names.has(name)
      );
      check(
        `${used.size} classes, all with a rule`,
        missing.length === 0,
        missing.length > 0
          ? `missing: ${missing.join(' ')} — rerun \`bun scripts/build-editor-css.ts\``
          : ''
      );
    },
  },
  {
    group: 'Export stylesheet',
    title: 'The export is self-contained',
    run: async (check) => {
      const html = await buildEditorDocument(createFixture());
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].map(
        (link) => link.getAttribute('href') ?? ''
      );
      check(
        'only the font stylesheet is linked',
        links.every((href) => href.startsWith('https://fonts.googleapis.com/')),
        links.join(' ')
      );
      check('no scripts', doc.querySelectorAll('script').length === 0);
      check('no platejs.org', !html.includes('platejs.org'));
      check(
        'html is right-to-left like the app',
        doc.documentElement.dir === 'rtl'
      );
    },
  },
  {
    group: 'Export stylesheet',
    title: 'KaTeX styles ship only with math',
    run: async (check) => {
      const plain = await buildEditorDocument([
        { type: KEYS.p, children: [{ text: 'no math' }] },
      ]);
      const math = await buildEditorDocument(createFixture());
      check('left out without math', !plain.includes(KATEX_FONT));
      check('inlined with math', math.includes(KATEX_FONT));
    },
  },
  {
    group: 'Rendering',
    title: 'The static render has every node',
    run: async (check) => {
      const root = parseBody(await renderEditorBody(createFixture()));
      for (const type of [...FIXTURE_TYPES, ...INLINE_TYPES]) {
        check(type, !!root && !!byType(root, type));
      }
    },
  },
  {
    group: 'Rendering',
    title: 'The editor has every node',
    run: async (check) => {
      if (useLab.getState().fixture !== 'full') loadFixture('full');
      const root = await element(() => {
        const found = editorRoot();
        return found && byType(found, KEYS.table) ? found : null;
      }, 'the editor');
      for (const type of [...FIXTURE_TYPES, ...INLINE_TYPES]) {
        check(type, !!byType(root, type));
      }
    },
  },
  {
    group: 'Rendering',
    title: 'Static nodes are styled like the editor',
    run: async (check) => {
      const editorPane = await element(editorRoot, 'the editor');
      const staticPane = await element(staticRoot, 'the static pane');
      for (const type of PROBE_TYPES) {
        const a = byType(editorPane, type);
        const b = byType(staticPane, type);
        if (!a || !b) {
          check(type, false, `missing in the ${a ? 'static' : 'editor'} pane`);
          continue;
        }
        const diff = styleDiff(getComputedStyle(a), getComputedStyle(b), [
          ...LAYOUT_PROPS,
          ...COLOR_PROPS,
        ]);
        check(type, diff.length === 0, diff.join('; '));
      }
    },
  },
  {
    group: 'Rendering',
    title: 'The export looks like the static render',
    run: async (check) => {
      const { doc, win } = await exportDocument();
      const staticPane = await element(staticRoot, 'the static pane');
      await doc.fonts.ready;
      // The export takes the lab's theme, so colors match as well, as long as
      // the app runs the default preset: a customized one lives only in the app.
      const props = [...LAYOUT_PROPS, ...COLOR_PROPS];
      for (const type of PROBE_TYPES) {
        const a = byType(staticPane, type);
        const b = byType(doc, type);
        if (!a || !b) {
          check(type, false, `missing in the ${a ? 'export' : 'static'} pane`);
          continue;
        }
        const diff = styleDiff(
          getComputedStyle(a),
          win.getComputedStyle(b),
          props
        );
        check(type, diff.length === 0, diff.join('; '));
      }
    },
  },
  {
    group: 'Rendering',
    title: 'Comments and suggestions stay in the dashboard',
    run: async (check) => {
      const html = await renderEditorBody(createFixture());
      const root = parseBody(html);
      check(
        'a pending insertion is left out',
        !html.includes('suggested insertion')
      );
      check(
        'a pending removal stays, unmarked',
        html.includes('suggested removal') &&
          !root?.querySelector('.slate-suggestion')
      );
      check(
        'commented text stays, unmarked',
        html.includes('commented text') &&
          !root?.querySelector('.slate-comment')
      );
      const markdown = createPublishedEditor(createFixture())
        .getApi(MarkdownPlugin)
        .markdown.serialize();
      check(
        'the Markdown export leaves the insertion out too',
        !markdown.includes('suggested insertion') &&
          markdown.includes('suggested removal')
      );
      check('"black" text keeps the theme color', !/color:\s*black/.test(html));
    },
  },
  {
    group: 'Rendering',
    title: 'Toggles open and close in the static and export panes',
    run: async (check) => {
      const staticPanes = await panes(['static', 'export']);
      for (const pane of staticPanes) exerciseToggle(check, pane);
    },
  },
  {
    group: 'Rendering',
    title: 'Table borders sit on their cells',
    run: async (check) => {
      const all = await panes();
      for (const [name, root, view] of all) {
        const off = [
          ...root.querySelectorAll<HTMLElement>(
            // Element cells only: the editor adds a handle column of its own.
            ':scope .slate-table :is(th, td)[data-slate-node="element"]'
          ),
        ].filter((cell) => {
          const box = view.getComputedStyle(cell, '::before');
          const width = cell.getBoundingClientRect().width;
          return box.left !== '0px' || Math.abs(pxOf(box.width) - width) > 1;
        });
        check(
          `${name}: every border box covers its cell`,
          off.length === 0,
          off.map((cell) => cell.textContent).join(', ')
        );
      }
    },
  },
  {
    group: 'Rendering',
    title: 'Text on an author-picked background stays readable',
    run: async (check) => {
      for (const theme of ['light', 'dark'] as const) {
        await withTheme(theme, async () => {
          const all = await panes();
          for (const [name, root, view] of all) {
            const at = `${theme} ${name}:`;
            const callout = byType(root, KEYS.callout);
            checkReadable(check, `${at} callout`, callout, view);
            const cells = [
              ...root.querySelectorAll<HTMLElement>(':scope .slate-td'),
            ];
            const cell = cells.find((el) =>
              el.textContent?.includes('Background')
            );
            checkReadable(check, `${at} cell`, cell, view);
            const styled = [
              ...root.querySelectorAll<HTMLElement>(':scope [style]'),
            ];
            const text = styled.find((el) => el.textContent === 'on yellow');
            checkReadable(check, `${at} text`, text, view);
          }
        });
      }
    },
  },
  {
    group: 'Rendering',
    title: 'Only the editor highlights an equation on hover',
    run: async (check) => {
      const all = await panes();
      for (const [name, root] of all) {
        const block = root.querySelector<HTMLElement>(
          ':scope .slate-equation [class*="justify-center"]'
        );
        const hover = block?.className.includes('hover:') ?? false;
        check(
          `${name}: ${name === 'editor' ? 'hover style' : 'no hover style'}`,
          !!block && hover === (name === 'editor'),
          block?.className
        );
      }
    },
  },
  {
    group: 'Rendering',
    title: 'A node waiting to be filled in shows only in the editor',
    run: async (check) => {
      const prompts = [
        EMPTY_EQUATION_LABEL,
        EMPTY_INLINE_EQUATION_LABEL,
        EMPTY_DATE_LABEL,
      ];
      const all = await panes();
      for (const [name, root] of all) {
        const text = root.textContent ?? '';
        for (const prompt of prompts) {
          check(
            `${name}: "${prompt}" ${name === 'editor' ? 'shown' : 'absent'}`,
            text.includes(prompt) === (name === 'editor')
          );
        }
      }
      const published = JSON.stringify(
        createPublishedEditor(createFixture()).children
      );
      check(
        'the published copy has no empty equation, so no export has one',
        !published.includes('"texExpression":""')
      );
    },
  },
  {
    group: 'Rendering',
    title: 'Equations are typeset in every pane',
    run: async (check) => {
      const all = await panes();
      for (const [name, root, view] of all) {
        const typeset = [
          ...root.querySelectorAll<HTMLElement>(':scope .katex'),
        ];
        check(`${name}: typeset`, typeset.length >= 2, String(typeset.length));
        // Without KaTeX's stylesheet its MathML copy shows beside the HTML.
        const shown = [
          ...root.querySelectorAll<HTMLElement>(':scope .katex-mathml'),
        ].filter((el) => view.getComputedStyle(el).position !== 'absolute');
        check(`${name}: the source is not shown twice`, shown.length === 0);
      }
    },
  },
  {
    group: 'Rendering',
    title: 'A checked todo shows a single check',
    run: async (check) => {
      const all = await panes();
      for (const [name, root] of all) {
        const done = [...root.querySelectorAll<HTMLElement>(':scope li')].find(
          (el) => el.textContent?.includes('Todo, done')
        );
        const icon = done?.parentElement?.querySelector('svg');
        check(
          `${name}: one stroke`,
          icon?.querySelectorAll('path').length === 1,
          `${icon?.querySelectorAll('path').length ?? 'no'} path(s)`
        );
      }
    },
  },
  {
    group: 'Rendering',
    title: 'The export takes the theme it is given',
    run: async (check) => {
      const light = await buildEditorDocument(createFixture());
      check('light by default', light.includes('data-theme="light"'));
      const dark = await buildEditorDocument(createFixture(), {
        theme: 'dark',
      });
      check('dark when asked', dark.includes('data-theme="dark"'));
    },
  },
  {
    group: 'Direction',
    title: 'Every pane carries the document direction',
    run: async (check) => {
      for (const dir of ['ltr', 'rtl'] as const) {
        await withState({ dir }, async () => {
          const { doc } = await exportDocument();
          check(
            `${dir}: editor root`,
            editorRoot()?.dir === dir,
            editorRoot()?.dir
          );
          check(
            `${dir}: static root`,
            staticRoot()?.dir === dir,
            staticRoot()?.dir
          );
          check(
            `${dir}: export root`,
            doc.querySelector<HTMLElement>('[data-slate-editor]')?.dir === dir
          );
          const root = editorRoot();
          const paragraph = root && byType(root, KEYS.p);
          check(
            `${dir}: an unset block inherits it`,
            !!paragraph && getComputedStyle(paragraph).direction === dir
          );
        });
      }
    },
  },
  {
    group: 'Direction',
    title: "A block's own dir wins",
    run: async (check) => {
      const { doc, win } = await exportDocument();
      for (const [name, root, view] of [
        ['editor', editorRoot(), globalThis],
        ['static', staticRoot(), globalThis],
        ['export', doc, win],
      ] as const) {
        const block = root?.querySelector<HTMLElement>(
          '[dir="rtl"][data-slate-node="element"]'
        );
        check(
          `${name}: the rtl paragraph is right-to-left`,
          !!block && view.getComputedStyle(block).direction === 'rtl'
        );
      }
    },
  },
  {
    group: 'Direction',
    title: "The drag handle sits on the block's start side",
    run: async (check) => {
      for (const dir of ['ltr', 'rtl'] as const) {
        await withState({ dir }, async () => {
          const root = await element(editorRoot, 'the editor');
          const count = root.querySelector<HTMLElement>('button[data-active]');
          const block = count?.closest<HTMLElement>('.slate-blockWrapper');
          const gutter = block?.parentElement?.querySelector<HTMLElement>(
            ':scope > .slate-gutterLeft'
          );
          if (!count || !block || !gutter) {
            check(`${dir}: the discussed block`, false);
            return;
          }
          const g = gutter.getBoundingClientRect();
          const b = block.getBoundingClientRect();
          const c = count.getBoundingClientRect();
          check(
            `${dir}: outside the ${dir === 'ltr' ? 'left' : 'right'} edge`,
            dir === 'ltr' ? g.right <= b.left + 1 : g.left >= b.right - 1,
            `gutter ${Math.round(g.left)}–${Math.round(g.right)}, block ${Math.round(b.left)}–${Math.round(b.right)}`
          );
          check(
            `${dir}: clear of the discussion button`,
            g.right <= c.left || g.left >= c.right,
            `button ${Math.round(c.left)}–${Math.round(c.right)}`
          );
        });
      }
    },
  },
  {
    group: 'Discussions',
    title: 'The reply field is an app input that does not scroll',
    run: async (check) => {
      const root = await element(editorRoot, 'the editor');
      const trigger = await element(
        () => root.querySelector<HTMLElement>('button[data-active]'),
        'the discussion button'
      );
      trigger.click();
      try {
        const box = await element(
          () =>
            document.querySelector<HTMLElement>(
              '[data-radix-popper-content-wrapper]'
            ),
          'the discussion box'
        );
        await wait(SETTLE_MS);
        const fields = [
          ...box.querySelectorAll<HTMLElement>('[data-slate-editor]'),
        ];
        check('has reply fields', fields.length > 0);
        // A font's text boxes can pass the line by a pixel: what matters is
        // whether anything scrolls, not the raw scrollHeight.
        const scrolls = (el: HTMLElement) =>
          ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight;
        for (const [i, field] of fields.entries()) {
          const surface = field.parentElement;
          check(
            `field ${i + 1}: nothing scrolls`,
            !scrolls(field) && !!surface && !scrolls(surface),
            `${field.scrollHeight}/${field.clientHeight}, field ${surface?.scrollHeight}/${surface?.clientHeight}`
          );
          check(
            `field ${i + 1}: drawn like the app inputs`,
            !!field.parentElement?.className.includes('bg-input'),
            field.parentElement?.className
          );
        }
        const send = box.querySelector<HTMLElement>(
          'button[aria-label="إرسال"]'
        );
        const width = send?.getBoundingClientRect().width ?? 0;
        const icon = send?.querySelector('svg')?.getBoundingClientRect().width;
        check(
          'the send button has room around its icon',
          icon !== undefined && width - icon >= 8,
          `${width}px button, ${icon}px icon`
        );
      } finally {
        trigger.click();
        await wait(SETTLE_MS);
      }
    },
  },
  {
    group: 'Round trips',
    title: 'Exported HTML imports back',
    run: async (check) => {
      // The whole exported file, through the import menu's own reader.
      const fixture = createPublishedEditor(createFixture()).children;
      const editor = createSlateEditor({ plugins: createBaseEditorKit() });
      const imported = deserializeEditorHtml(
        editor,
        await buildEditorDocument(fixture)
      );
      check(
        'the toggle rules and switches do not come back as text',
        !JSON.stringify(imported).includes('editor-toggle-'),
        /.{0,40}editor-toggle-.{0,40}/.exec(JSON.stringify(imported))?.[0]
      );
      const want = topTypes(fixture);
      const got = topTypes(imported);
      const read = new Set(got);
      const lost = [...new Set(want.filter((type) => !read.has(type)))];
      check(
        `${got.length} of ${want.length} blocks read back`,
        got.length > 0,
        lost.length > 0 ? `types not read back: ${lost.join(', ')}` : ''
      );
    },
  },
  {
    group: 'Round trips',
    title: 'An HTML page from elsewhere imports',
    run: (check) => {
      const editor = createSlateEditor({ plugins: createBaseEditorKit() });
      const imported = deserializeEditorHtml(
        editor,
        '<!DOCTYPE html><html><head><title>x</title></head><body><h1>Title</h1><p>Some <b>bold</b> text.</p><ul><li>one</li></ul></body></html>'
      );
      const types = topTypes(imported);
      check('the heading', types[0] === KEYS.h1, types.join(', '));
      check(
        'the text and its bold',
        JSON.stringify(imported).includes('"bold":true') &&
          JSON.stringify(imported).includes('Some '),
        JSON.stringify(imported).slice(0, 200)
      );
    },
  },
  {
    group: 'Round trips',
    title: 'Markdown keeps the blocks it can express',
    run: (check) => {
      const markdownTypes = new Set<string>([
        ...KEYS.heading,
        KEYS.p,
        KEYS.blockquote,
        KEYS.codeBlock,
        KEYS.hr,
        KEYS.table,
      ]);
      const editor = createSlateEditor({
        plugins: createBaseEditorKit(),
        value: createFixture(),
      });
      const api = editor.getApi(MarkdownPlugin).markdown;
      const back = api.deserialize(api.serialize());
      const want = topTypes(createFixture()).filter((t) =>
        markdownTypes.has(t)
      );
      const missing = [...new Set(want).difference(new Set(topTypes(back)))];
      check(
        'every markdown block type survives',
        missing.length === 0,
        missing.join(', ')
      );
    },
  },
  {
    group: 'Helpers',
    title: 'Date labels',
    run: (check) => {
      const now = new Date(2026, 8, 28, 12);
      const at = (offset: number) =>
        new Date(2026, 8, 28 + offset, 9).toDateString();
      check('today', formatDateLabel(at(0), now) === 'اليوم');
      check('yesterday', formatDateLabel(at(-1), now) === 'أمس');
      check('tomorrow', formatDateLabel(at(1), now) === 'غداً');
      check(
        'another day',
        formatDateLabel(at(10), now) === 'October 8, 2026',
        formatDateLabel(at(10), now)
      );
      check('missing', formatDateLabel(undefined, now) === EMPTY_DATE_LABEL);
      check(
        'unreadable',
        formatDateLabel('not a date', now) === EMPTY_DATE_LABEL
      );
    },
  },
  {
    group: 'Helpers',
    title: 'Font sizes never become NaN',
    run: (check) => {
      check('"24px" reads as 24', parseFontSize('24px') === 24);
      check(
        'the default label reads as none',
        parseFontSize('الافتراضي') === null
      );
      check('0 is refused', parseFontSize('0') === null);
      check(
        'over the max is refused',
        parseFontSize(String(FONT_SIZE_MAX + 1)) === null
      );
      check('+1 from default', stepFontSize(null, 1) === BASE_FONT_SIZE + 1);
      check(
        'stays within the max',
        stepFontSize(FONT_SIZE_MAX, 1) === FONT_SIZE_MAX
      );
      check('stays above 0', stepFontSize(1, -1) === 1);
    },
  },
  {
    group: 'Helpers',
    title: 'Media alignment is physical',
    run: (check) => {
      const cls = (align: unknown) =>
        mediaAlignVariants({ align: toMediaAlign(align) });
      check('left → mr-auto', cls('left').includes('mr-auto'));
      check('right → ml-auto', cls('right').includes('ml-auto'));
      check('start → me-auto', cls('start').includes('me-auto'));
      check('unknown → centered', cls('diagonal').includes('mx-auto'));
    },
  },
  {
    group: 'Helpers',
    title: 'One catalogue behind every block menu',
    run: (check) => {
      const editor = createSlateEditor({ plugins: createBaseEditorKit() });
      const all = Object.values(BLOCK_TYPES);
      const known = (value: string) =>
        value === THREE_COLUMNS ||
        value === KEYS.ul ||
        value === KEYS.ol ||
        value === KEYS.listTodo ||
        value in editor.plugins;
      check(
        'values are unique',
        new Set(all.map((i) => i.value)).size === all.length
      );
      check(
        'labels are unique',
        new Set(all.map((i) => i.label)).size === all.length
      );
      const unknown = [
        ...TURN_INTO_ITEMS,
        ...INSERT_GROUPS.flatMap((g) => g.items),
      ].filter((item) => !known(item.value));
      check(
        'every item is a registered node type',
        unknown.length === 0,
        unknown.map((i) => i.value).join(', ')
      );
    },
  },
  {
    group: 'Editor contract',
    title: 'Clear formatting turns a code block into paragraphs',
    run: (check) => {
      const editor = createSlateEditor({
        plugins: createBaseEditorKit(),
        value: [
          {
            type: KEYS.codeBlock,
            children: ['const a = 1;', 'const b = 2;'].map((line) => ({
              type: KEYS.codeLine,
              children: [{ text: line }],
            })),
          },
          { type: KEYS.h1, align: 'center', children: [{ text: 'Title' }] },
        ],
      });
      editor.tf.select([]);
      clearFormatting(editor);
      const blocks = editor.children;
      check(
        'every block is a paragraph',
        blocks.every((block) => block.type === KEYS.p),
        topTypes(blocks).join(', ')
      );
      check(
        'each code line keeps its text',
        blocks[0] !== undefined && NodeApi.string(blocks[0]) === 'const a = 1;',
        blocks.map((block) => NodeApi.string(block)).join(' | ')
      );
      check(
        'the alignment is gone',
        blocks.every((block) => !block.align)
      );
    },
  },
  {
    group: 'Editor contract',
    title: 'Blur reports the document',
    run: async (check) => {
      const root = await element(editorRoot, 'the editor');
      const before = useLab.getState().changes;
      root.focus();
      await wait(SETTLE_MS);
      // A background (or headless) window sets focus without firing focus
      // events, so blur may not fire either: also send the one React listens for.
      root.blur();
      root.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await waitFor(() => useLab.getState().changes > before, 'onChange');
      const { value } = useLab.getState();
      check(
        'onChange receives the whole document',
        topTypes(value).length === topTypes(createFixture()).length,
        `${topTypes(value).length} blocks`
      );
    },
  },
  {
    group: 'Browser support',
    title: 'The served export stylesheets passed the browserslist check',
    run: async (check) => {
      // The build writes the stamp only after scripts/css-support.ts found
      // nothing that breaks; a file without it is stale or unchecked.
      for (const url of [DOCUMENT_CSS_URL, KATEX_CSS_URL]) {
        const css = await fetch(url).then((r) => r.text());
        const stamp = /^\/\*! (.*?) \*\//.exec(css)?.[1] ?? '';
        check(
          url,
          stamp.startsWith(CHECKED_STAMP),
          stamp || 'no stamp: rerun `bun scripts/build-editor-css.ts`'
        );
      }
    },
  },
  {
    group: 'Browser support',
    title: 'The toggle arrow mirrors without :dir()',
    run: async (check) => {
      const arrow = (root: ParentNode | null) =>
        root?.querySelector<SVGElement>(':scope .slate-toggle svg') ?? null;
      const scaleX = (el: Element | null) => {
        const view = el?.ownerDocument.defaultView;
        if (!el || !view) return NaN;
        const matrix = new DOMMatrixReadOnly(
          view.getComputedStyle(el).transform
        );
        return Math.sign(matrix.a);
      };
      for (const dir of ['ltr', 'rtl'] as const) {
        await withState({ dir }, async () => {
          const { doc } = await exportDocument();
          const want = dir === 'rtl' ? -1 : 1;
          check(`${dir}: editor`, scaleX(arrow(editorRoot())) === want);
          check(`${dir}: static`, scaleX(arrow(staticRoot())) === want);
          check(`${dir}: export`, scaleX(arrow(doc)) === want);
        });
      }
    },
  },
  {
    group: 'Browser support',
    title: 'Toolbar groups show without :has()',
    run: async (check) => {
      const toolbar = await element(
        () =>
          pane('editor')?.querySelector<HTMLElement>('[role="toolbar"]') ??
          null,
        'the toolbar'
      );
      const groups = [
        ...toolbar.querySelectorAll(String.raw`.group\/toolbar-group`),
      ];
      const hidden = groups.filter(
        (group) =>
          group.querySelector('button') &&
          getComputedStyle(group).display === 'none'
      );
      check(
        `${groups.length} groups with buttons are displayed`,
        groups.length > 0 && hidden.length === 0
      );
      check(
        'no has-[…] class left in the toolbar',
        !toolbar.outerHTML.includes('has-[')
      );
    },
  },
  {
    group: 'Known issue',
    title: "Markdown export drops a toggle's title (reproduces while unfixed)",
    run: (check) => {
      const { markdown, back } = markdownRoundTrip(toggleDocument());
      check(
        'the title is missing from the Markdown',
        !markdown.includes(TOGGLE_TITLE),
        JSON.stringify(markdown)
      );
      check(
        'the content reads back as a plain paragraph',
        back.some((n) => n.type === KEYS.p && n.text === TOGGLE_CONTENT) &&
          !back.some((n) => n.type === KEYS.toggle)
      );
    },
  },
  {
    group: 'Discussions',
    title: 'Discussion code writes no options during render',
    run: async (check) => {
      const remount = await element(
        () => document.querySelector<HTMLElement>('[data-lab-remount-demo]'),
        'the render-write guard'
      );
      remount.click();
      await element(
        () =>
          document.querySelector(
            `#${CSS.escape(RENDER_DEMO_ID)} .slate-comment`
          ),
        'the guard comment'
      );
      await wait(SETTLE_MS * 3);
      const { probe } = useRenderWrites.getState();
      check(
        'the detector tells a render from an effect and a timer',
        probe?.render === true && !probe.effect && !probe.timeout,
        JSON.stringify(probe)
      );
      const described = () =>
        useRenderWrites
          .getState()
          .writes.map((w) => `${w.plugin}.${w.option} ← ${w.stack}`)
          .join('; ');
      check(
        'none on mount',
        useRenderWrites.getState().writes.length === 0,
        described()
      );
      const move = await element(
        () => document.querySelector<HTMLElement>('[data-lab-move-comment]'),
        'the move button'
      );
      move.click();
      await wait(SETTLE_MS * 3);
      check(
        'none when the thread moves to another block',
        useRenderWrites.getState().writes.length === 0,
        described()
      );
    },
  },
  {
    group: 'Performance',
    title: 'A 300-block export',
    run: async (check) => {
      const { createStressFixture } = await import('./fixture');
      const started = performance.now();
      const html = await buildEditorDocument(createStressFixture());
      const ms = Math.round(performance.now() - started);
      check(
        'builds',
        html.length > 0,
        `${ms}ms, ${(html.length / 1024).toFixed(0)} KiB`
      );
    },
  },
];

export async function runScenarios(scenarios: Scenario[]) {
  if (useLab.getState().running) return;
  const results: LabResult[] = [];
  useLab.setState({ results });
  try {
    for (const scenario of scenarios) {
      useLab.setState({ running: scenario.title });
      const check: Check = (name, ok, detail = '') => {
        results.push({ group: scenario.title, check: name, ok, detail });
        useLab.setState({ results: [...results] });
      };
      try {
        await scenario.run(check);
      } catch (error) {
        check('ran to the end', false, String(error));
      }
    }
  } finally {
    useLab.setState({ running: null });
  }
}
