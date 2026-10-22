import type { RowLimits } from './lab-store';

import { LIMITS, PREVIEW_DEFAULTS, useLab } from './lab-store';

type Check = (check: string, ok: boolean, detail?: string) => void;

interface Scenario {
  title: string;
  run: (check: Check) => Promise<void>;
}

// `html` scrolls smoothly (base.css); a correction would animate for about this long.
const SETTLE_MS = 400;
// Far wider than the app's font, so loading it always re-wraps the text.
const WIDE_FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Rubik+Mono+One&display=swap';
const WORDS =
  'Autosize keeps the field as tall as its text: it grows with every wrapped line up to its limit, then scrolls.';
const ROUNDING_COMBOS = [
  [1.13, 1.37],
  [0.97, 1.55],
  [1.21, 1.43],
  [1.07, 1.61],
  [1.33, 1.29],
] as const;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
// Observers deliver after layout, so a resize lands a frame or two later.
async function frames(count = 2) {
  for (let i = 0; i < count; i += 1) await frame();
}

const find = (name: string) =>
  document.querySelector<HTMLElement>(`[data-lab="${CSS.escape(name)}"]`);

function textarea(name: string) {
  const el = find(name);
  if (!el) throw new Error(`[data-lab="${name}"] is not on the page`);
  const field =
    el instanceof HTMLTextAreaElement ? el : el.querySelector('textarea');
  if (!field) throw new Error(`[data-lab="${name}"] holds no textarea`);
  return field;
}

function scroller(name: string) {
  const el = find(name);
  if (!el) throw new Error(`[data-lab="${name}"] is not on the page`);
  return el;
}

/** Replaces the text the way typing does, so React and react-hook-form see it. */
function type(el: HTMLTextAreaElement, value: string) {
  const nativeValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  if (!nativeValue) throw new Error('HTMLTextAreaElement has no value setter');
  nativeValue.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const lines = (count: number, text = 'line') =>
  Array.from({ length: count }, (_, i) => `${text} ${i + 1}`).join('\n');

const px = (value: string) => Number(value.replace('px', '')) || 0;
const height = (el: HTMLElement) => el.getBoundingClientRect().height;

interface Probe {
  content: number;
  lineHeight: number;
  chrome: number;
}

/**
 * Measures `value` in a hidden copy of the field at its width, the way
 * react-textarea-autosize does: an oracle that shares no code with the
 * component under test.
 */
function probe(
  el: HTMLTextAreaElement,
  value = el.value,
  overflowY: 'hidden' | 'scroll' = 'hidden'
): Probe {
  const copy = el.cloneNode() as HTMLTextAreaElement;
  for (const name of ['data-lab', 'id', 'name']) copy.removeAttribute(name);
  copy.setAttribute('aria-hidden', 'true');
  copy.tabIndex = -1;
  copy.value = value;
  Object.assign(copy.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    height: '0',
    minHeight: '0',
    maxHeight: 'none',
    overflowY,
    width: `${el.getBoundingClientRect().width}px`,
  });
  el.after(copy);
  const style = getComputedStyle(copy);
  const border = px(style.borderTopWidth) + px(style.borderBottomWidth);
  const result = {
    content: copy.scrollHeight + border,
    lineHeight: px(style.lineHeight),
    chrome: border + px(style.paddingTop) + px(style.paddingBottom),
  };
  copy.remove();
  return result;
}

const lineCount = (p: Probe) =>
  Math.round((p.content - p.chrome) / p.lineHeight);

function expected(el: HTMLTextAreaElement, { minRows, maxRows }: RowLimits) {
  const p = probe(el);
  const min = minRows * p.lineHeight + p.chrome;
  const max = maxRows * p.lineHeight + p.chrome;
  return {
    height: Math.max(min, Math.min(p.content, max)),
    // `scrollHeight` is whole pixels; real overflow is at least a line.
    overflows: p.content - max > 1,
    lines: lineCount(p),
  };
}

/** The field's height and scrollbar match the oracle's; returns the height. */
function checkFits(
  check: Check,
  label: string,
  el: HTMLTextAreaElement,
  limits: RowLimits
) {
  const want = expected(el, limits);
  const got = height(el);
  check(
    `${label}: height fits the text`,
    Math.abs(got - want.height) <= 1,
    `${got.toFixed(1)}px, expected ${want.height.toFixed(1)}px (${want.lines} lines)`
  );
  const { overflowY } = getComputedStyle(el);
  const wantOverflow = want.overflows ? 'auto' : 'hidden';
  check(
    `${label}: scrollbar ${want.overflows ? 'allowed' : 'hidden'}`,
    overflowY === wantOverflow,
    overflowY
  );
  return got;
}

const copiesAdded = (records: MutationRecord[]) =>
  records
    .flatMap((r) => [...r.addedNodes])
    .filter((node) => node instanceof HTMLTextAreaElement).length;

/** Each measure adds its hidden copy beside the field exactly once. */
async function countMeasures(el: HTMLTextAreaElement, action: () => void) {
  const parent = el.parentElement;
  if (!parent) throw new Error('the field has no parent');
  let count = 0;
  const observer = new MutationObserver((records) => {
    count += copiesAdded(records);
  });
  observer.observe(parent, { childList: true });
  action();
  await frames();
  count += copiesAdded(observer.takeRecords());
  observer.disconnect();
  return count;
}

/** Sets an offset at once, past `html`'s smooth scrolling. */
function jumpTo(node: HTMLElement, top: number) {
  const { scrollBehavior } = node.style;
  node.style.scrollBehavior = 'auto';
  node.scrollTop = top;
  node.style.scrollBehavior = scrollBehavior;
}

/**
 * Fills the field to its limit, scrolls `node` to its end, types one more
 * character, and reports how far the offset moved.
 */
async function driftAfterTyping(node: HTMLElement, el: HTMLTextAreaElement) {
  type(el, lines(LIMITS.scroll.maxRows));
  await frames();
  jumpTo(node, node.scrollHeight - node.clientHeight);
  await frames();
  return driftAfter(node, () => type(el, `${el.value}!`));
}

/** How far `node` moved during `action`, at once and once smooth scrolling settles. */
async function driftAfter(node: HTMLElement, action: () => void) {
  const before = node.scrollTop;
  const offsets: number[] = [];
  const record = () => {
    offsets.push(Math.round(node.scrollTop));
  };
  const target = node === document.documentElement ? globalThis : node;
  target.addEventListener('scroll', record);
  action();
  const atOnce = node.scrollTop - before;
  await wait(SETTLE_MS);
  target.removeEventListener('scroll', record);
  return {
    atOnce,
    settled: node.scrollTop - before,
    trail: offsets.length > 0 ? offsets.join(' → ') : 'no scroll events',
  };
}

function checkStill(
  check: Check,
  label: string,
  drift: Awaited<ReturnType<typeof driftAfter>>
) {
  check(
    `${label}: the offset stays at once`,
    Math.abs(drift.atOnce) <= 1,
    `${drift.atOnce}px`
  );
  check(
    `${label}: and once scrolling settles`,
    Math.abs(drift.settled) <= 1,
    `${drift.settled}px; scroll events: ${drift.trail}`
  );
}

/** Where the caret's line sits in the viewport; the fixtures' lines never wrap. */
function caretTop(el: HTMLTextAreaElement) {
  const style = getComputedStyle(el);
  const line = el.value.slice(0, el.selectionEnd).split('\n').length - 1;
  return (
    el.getBoundingClientRect().top +
    px(style.borderTopWidth) +
    px(style.paddingTop) +
    line * px(style.lineHeight) -
    el.scrollTop
  );
}

const exec = (command: string, text?: string) =>
  document.execCommand(command, false, text);

/** Selects from the caret back over `count` whole lines. */
function selectLinesAbove(el: HTMLTextAreaElement, count: number) {
  let start = el.selectionEnd;
  for (let i = 0; i < count; i += 1)
    start = Math.max(0, el.value.lastIndexOf('\n', start - 1));
  el.setSelectionRange(start, el.selectionEnd);
}

interface EditResult {
  ran: boolean;
  restored: boolean | null;
  drift: Awaited<ReturnType<typeof driftAfter>>;
  caret: number;
}

/**
 * Fills `el` past the screen's height, puts the caret mid-screen, then runs
 * each edit followed at once by its undo. The browser's own commands run its
 * caret reveal and fill its undo stack, as real typing does; undoing each edit
 * straight away keeps Chrome's merging of consecutive typing out of it.
 */
async function editTallField(el: HTMLTextAreaElement, count: number) {
  const page = document.documentElement;
  const lineHeight = px(getComputedStyle(el).lineHeight);
  type(el, lines(count));
  await frames();
  el.focus({ preventScroll: true });
  const middle = el.value
    .split('\n')
    .slice(0, Math.floor(count / 2))
    .join('\n').length;
  el.setSelectionRange(middle, middle);
  jumpTo(page, page.scrollTop + caretTop(el) - innerHeight / 2);
  await frames();

  const screenful = lines(Math.ceil(innerHeight / lineHeight), 'pasted');
  const edits: [string, () => boolean][] = [
    ['typing a character', () => exec('insertText', 'x')],
    ['pasting a screenful of lines', () => exec('insertText', screenful)],
    [
      'deleting five lines',
      () => {
        selectLinesAbove(el, 5);
        return exec('delete');
      },
    ],
  ];

  const results = new Map<string, EditResult>();
  const run = async (label: string, action: () => boolean, undoes?: string) => {
    let ran = false;
    const drift = await driftAfter(page, () => {
      ran = action();
    });
    results.set(label, {
      ran,
      restored: undoes === undefined ? null : el.value === undoes,
      drift,
      caret: caretTop(el),
    });
  };
  for (const [label, edit] of edits) {
    const before = el.value;
    await run(label, edit);
    await run(`undo ${label}`, () => exec('undo'), before);
  }
  el.blur();
  return results;
}

/** A line that wraps only while a scrollbar takes its width; null with overlay scrollbars. */
function wrapsUnderScrollbar(el: HTMLTextAreaElement) {
  // Short words, so one step is narrower than any classic scrollbar.
  for (let words = 1; words < 600; words += 1) {
    const line = Array.from({ length: words }, () => 'i').join(' ');
    if (lineCount(probe(el, line)) > 1) return null;
    if (lineCount(probe(el, line, 'scroll')) > 1) return line;
  }
  return null;
}

async function wideFontFace() {
  const response = await fetch(WIDE_FONT_CSS);
  if (!response.ok) throw new Error(`Google Fonts answered ${response.status}`);
  const src = /url\((https:[^)]+)\)/.exec(await response.text())?.[1];
  if (!src) throw new Error('the Google Fonts stylesheet names no font file');
  // A new family each run, so the face loads, and fires `loadingdone`, every time.
  return new FontFace(`TextareaLab${Date.now()}`, `url(${src})`);
}

export const SCENARIOS: Scenario[] = [
  {
    title: 'Limits: grows from minRows to maxRows, then scrolls',
    run: async (check) => {
      const el = textarea('rhf-notes');
      const { maxRows } = LIMITS.rhf;
      const steps: [string, string][] = [
        ['empty', ''],
        ['two lines', lines(2)],
        ['between the limits', lines(maxRows - 1)],
        ['past maxRows', lines(maxRows + 6)],
        ['emptied again', ''],
      ];
      for (const [label, value] of steps) {
        type(el, value);
        await frames();
        checkFits(check, label, el, LIMITS.rhf);
      }
    },
  },
  {
    title: 'Mount: react-hook-form writes the value before the first measure',
    run: async (check) => {
      checkFits(check, 'prefilled', textarea('rhf-prefilled'), LIMITS.rhf);
    },
  },
  {
    title: 'A scrollbar never narrows the measured lines',
    run: async (check) => {
      const el = textarea('rhf-notes');
      const line = wrapsUnderScrollbar(el);
      if (!line) {
        check('overlay scrollbars take no width: nothing to narrow', true);
        return;
      }
      type(el, lines(LIMITS.rhf.maxRows + 6));
      await frames();
      check(
        'starts past the limit, scrollbar allowed',
        getComputedStyle(el).overflowY === 'auto'
      );
      // Each line wraps in two only while the old scrollbar is still showing.
      type(
        el,
        Array.from({ length: LIMITS.rhf.minRows }, () => line).join('\n')
      );
      await frames();
      checkFits(check, 'back under the limit', el, LIMITS.rhf);
      type(el, '');
      await frames();
    },
  },
  {
    title: 'One keystroke, one measure',
    run: async (check) => {
      const fields: [string, string][] = [
        ['controlled (font preview)', 'font-preview'],
        ['uncontrolled (react-hook-form)', 'rhf-notes'],
      ];
      for (const [label, name] of fields) {
        const el = textarea(name);
        type(el, 'a');
        await frames();
        const count = await countMeasures(el, () => type(el, 'ab'));
        check(label, count === 1, `${count} measures`);
      }
    },
  },
  {
    title: 'Font preview: typography props resize the field',
    run: async (check) => {
      const el = textarea('font-preview');
      type(el, `${WORDS}\n${WORDS}`);
      await frames();
      const steps: [string, Partial<typeof PREVIEW_DEFAULTS>, boolean][] = [
        ['font size ×1.4', { fontSizeMultiplier: 1.4 }, true],
        ['line height 2', { lineHeight: 2 }, true],
        ['letter spacing 3px', { letterSpacing: 3 }, false],
        ['defaults', PREVIEW_DEFAULTS, true],
      ];
      for (const [label, patch, mustMove] of steps) {
        const before = height(el);
        useLab.setState(patch);
        await frames();
        const after = checkFits(check, label, el, LIMITS.preview);
        if (mustMove)
          check(
            `${label}: the height followed`,
            Math.abs(after - before) > 1,
            `${before.toFixed(1)} → ${after.toFixed(1)}px`
          );
      }
    },
  },
  {
    title: 'Rounding: exactly maxRows lines show no scrollbar',
    run: async (check) => {
      const el = textarea('font-preview');
      const { maxRows } = LIMITS.preview;
      for (const [fontSizeMultiplier, lineHeight] of ROUNDING_COMBOS) {
        useLab.setState({ fontSizeMultiplier, lineHeight });
        const label = `${fontSizeMultiplier}× size, ${lineHeight} line height`;
        type(el, lines(maxRows, 'x'));
        await frames();
        checkFits(check, `${label}, ${maxRows} lines`, el, LIMITS.preview);
        type(el, lines(maxRows + 1, 'x'));
        await frames();
        checkFits(check, `${label}, ${maxRows + 1} lines`, el, LIMITS.preview);
      }
      useLab.setState(PREVIEW_DEFAULTS);
      type(el, '');
      await frames();
    },
  },
  {
    title: '--font-scale on the root rescales the field',
    run: async (check) => {
      const root = document.documentElement;
      const inline = root.style.getPropertyValue('--font-scale');
      const scale =
        px(getComputedStyle(root).getPropertyValue('--font-scale')) || 1;
      const el = textarea('rhf-notes');
      type(el, lines(LIMITS.rhf.maxRows - 2));
      await frames();
      const before = height(el);
      try {
        root.style.setProperty('--font-scale', String(scale + 0.3));
        await frames();
        const after = checkFits(check, 'scaled up', el, LIMITS.rhf);
        check(
          'the scale reached the field',
          Math.abs(after - before) > 1,
          `${before.toFixed(1)} → ${after.toFixed(1)}px`
        );
      } finally {
        if (inline) root.style.setProperty('--font-scale', inline);
        else root.style.removeProperty('--font-scale');
      }
      await frames();
      checkFits(check, 'scale restored', el, LIMITS.rhf);
      type(el, '');
      await frames();
    },
  },
  {
    title: 'Width: re-wraps on resize and when shown again',
    run: async (check) => {
      const el = textarea('resize');
      useLab.setState({ narrow: false, hidden: false });
      type(el, `${WORDS} ${WORDS}`);
      await frames();
      const wide = checkFits(check, 'full width', el, LIMITS.resize);
      useLab.setState({ narrow: true });
      await frames(3);
      const narrow = checkFits(check, 'half width', el, LIMITS.resize);
      check(
        'half width wraps into more lines',
        narrow > wide + 1,
        `${wide.toFixed(1)} → ${narrow.toFixed(1)}px`
      );
      useLab.setState({ narrow: false });
      await frames(3);
      checkFits(check, 'full width again', el, LIMITS.resize);
      useLab.setState({ hidden: true });
      await frames();
      type(el, `${WORDS} ${WORDS} ${WORDS}`);
      useLab.setState({ hidden: false });
      await frames(3);
      checkFits(
        check,
        'typed into while hidden, then shown',
        el,
        LIMITS.resize
      );
    },
  },
  {
    title: 'A web font that loads after the measure',
    run: async (check) => {
      const el = textarea('font-load');
      // Long enough to pass minRows in either font.
      type(el, `${WORDS} ${WORDS} ${WORDS}`);
      await frames();
      const face = await wideFontFace();
      document.fonts.add(face);
      try {
        // Set outside React, so only the font's own load can prompt a measure.
        el.style.fontFamily = `"${face.family}", monospace`;
        const before = height(el);
        await face.load();
        await frames();
        const want = expected(el, LIMITS.fontLoad).height;
        check(
          'the font changes the height (else this proves nothing)',
          Math.abs(want - before) > 1,
          `${before.toFixed(1)} → ${want.toFixed(1)}px`
        );
        checkFits(check, 'after the font loads', el, LIMITS.fontLoad);
      } finally {
        el.style.fontFamily = '';
        document.fonts.delete(face);
        type(el, '');
      }
    },
  },
  {
    title: 'Scroll: an inner scroller keeps its offset',
    run: async (check) => {
      const control = await driftAfterTyping(
        scroller('inner-control-scroller'),
        textarea('inner-control')
      );
      check(
        'control: the old measurement jumps here (else this proves nothing)',
        control.settled < -1,
        `${control.settled}px; scroll events: ${control.trail}`
      );
      checkStill(
        check,
        'typing at the end',
        await driftAfterTyping(
          scroller('inner-real-scroller'),
          textarea('inner-real')
        )
      );
    },
  },
  {
    title:
      'A field taller than the screen: typing and undo keep the caret in view',
    run: async (check) => {
      const el = textarea('tall');
      const plain = textarea('tall-control');
      const lineHeight = px(getComputedStyle(el).lineHeight);
      const count = Math.ceil((innerHeight * 1.5) / lineHeight);
      // Tall enough never to resize, so it shows what the browser does alone.
      plain.rows = count + Math.ceil(innerHeight / lineHeight) + 2;
      const baseline = await editTallField(plain, count);
      const ours = await editTallField(el, count);
      check(
        'the field is taller than the screen',
        height(el) > innerHeight,
        `${height(el).toFixed(0)}px of ${innerHeight}px`
      );

      const onScreen = (top: number) =>
        top >= 0 && top + lineHeight <= innerHeight;
      for (const [label, result] of ours) {
        const control = baseline.get(label);
        if (!control) throw new Error(`the plain textarea skipped "${label}"`);
        check(`${label}: the browser ran it`, result.ran);
        if (result.restored !== null)
          check(`${label}: restores the text exactly`, result.restored);
        check(
          `${label}: the page moves as it does for a plain textarea`,
          Math.abs(result.drift.settled - control.drift.settled) <= 1,
          `ours ${result.drift.settled.toFixed(0)}px (${result.drift.trail}), plain ${control.drift.settled.toFixed(0)}px`
        );
        check(
          `${label}: the caret's line is on screen, if it is for a plain textarea`,
          onScreen(result.caret) || !onScreen(control.caret),
          `ours at ${result.caret.toFixed(0)}px, plain at ${control.caret.toFixed(0)}px, screen ${innerHeight}px`
        );
        checkFits(check, label, el, LIMITS.tall);
      }
    },
  },
  {
    title: 'Scroll: the page keeps its offset',
    run: async (check) => {
      // No control: Chrome does not reliably clamp the page's own offset
      // during a script's forced layout, so the old measurement only sometimes
      // jumps here. The inner scroller's control and the tall field's plain
      // baseline carry that proof.
      const page = document.documentElement;
      checkStill(
        check,
        'typing at the end',
        await driftAfterTyping(page, textarea('page-real'))
      );
      jumpTo(page, 0);
    },
  },
];

export async function runScenarios(scenarios: Scenario[]) {
  useLab.setState({ results: [] });
  for (const scenario of scenarios) {
    useLab.setState({ running: scenario.title });
    const check: Check = (name, ok, detail = '') =>
      useLab.setState((s) => ({
        results: [
          ...s.results,
          { scenario: scenario.title, check: name, ok, detail },
        ],
      }));
    try {
      await scenario.run(check);
    } catch (error) {
      check('ran to the end', false, String(error));
      useLab.setState({ ...PREVIEW_DEFAULTS, narrow: false, hidden: false });
    }
  }
  useLab.setState({ running: null });
}
