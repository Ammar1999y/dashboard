import { useLab } from './lab-store';
import { probes, resetProbes } from './probes';

type Check = (check: string, ok: boolean, detail?: string) => void;

interface Scenario {
  title: string;
  run: (check: Check) => Promise<void>;
}

const RENDER_MS = 100;
// Radix adds its outside-press listener a tick after a layer mounts.
const LAYER_MS = 50;
// The dialog animates out before Radix unmounts it.
const EXIT_MS = 400;
const SCROLL_PX = 40;

const SCROLL_KINDS = ['element', 'component', 'siblings', 'spaced'] as const;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const find = (name: string) =>
  document.querySelector<HTMLElement>(`[data-lab="${CSS.escape(name)}"]`);

const lab = (name: string) => {
  const el = find(name);
  if (!el) throw new Error(`[data-lab="${name}"] is not on the page`);
  return el;
};

const isOpen = (name: string) => find(name)?.dataset.state === 'open';

/** A closing layer stays the top one, and takes Escape, until it unmounts. */
async function untilGone(name: string) {
  for (let waited = 0; find(name) && waited < EXIT_MS; waited += RENDER_MS)
    await wait(RENDER_MS);
  return find(name) === null;
}

const describe = (el: Element | null) =>
  el
    ? `${el.tagName.toLowerCase()}${el instanceof HTMLElement && el.dataset.lab ? `[data-lab=${el.dataset.lab}]` : ''}`
    : 'null';

const describedBy = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);

const wheel = (target: Element) => {
  const event = new WheelEvent('wheel', {
    deltaY: SCROLL_PX,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
};

/** A primary-button press as a mouse makes it: pointerdown, then click. */
const press = (target: HTMLElement) => {
  target.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse',
    })
  );
  target.click();
};

const escape = (target: Element) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );

async function closeDialog() {
  if (!isOpen('dialog')) return;
  escape(document.activeElement ?? document.body);
  await wait(EXIT_MS);
}

export const SCENARIOS: Scenario[] = [
  {
    title: 'Scroll area: one element is viewport and content',
    run: async (check) => {
      for (const kind of SCROLL_KINDS) {
        const root = lab(`scroll-${kind}`);
        const viewport = root.querySelector<HTMLElement>(
          ':scope > [data-radix-scroll-area-viewport]'
        );
        check(`${kind}: the viewport is the root's child`, viewport !== null);
        if (!viewport) continue;
        const { display } = getComputedStyle(viewport);
        check(
          `${kind}: the viewport is display:block`,
          display === 'block',
          display
        );
        check(
          `${kind}: the content sits directly in the viewport`,
          viewport.querySelector(':scope > [data-lab-content]') !== null,
          describe(viewport.firstElementChild)
        );
        check(
          `${kind}: the viewport spans the area`,
          Math.abs(viewport.clientWidth - root.clientWidth) <= 1,
          `${viewport.clientWidth} of ${root.clientWidth}`
        );
        viewport.scrollTop = SCROLL_PX;
        check(
          `${kind}: the viewport scrolls`,
          viewport.scrollTop > 0,
          `scrollTop ${viewport.scrollTop}`
        );
        viewport.scrollTop = 0;
      }
      const spaced =
        lab('scroll-spaced').querySelectorAll<HTMLElement>(
          '[data-lab-content]'
        );
      const second = spaced[1];
      const margin = second ? getComputedStyle(second).marginTop : 'none';
      check(
        "spaced: the viewport's own classes reach its children",
        margin !== 'none' && margin !== '0px',
        margin
      );
    },
  },
  {
    title: 'Popover inside a modal dialog',
    run: async (check) => {
      lab('open-dialog').click();
      await wait(RENDER_MS);
      check('the dialog opens', isOpen('dialog'));

      lab('dialog-popover-trigger').click();
      await wait(RENDER_MS);
      check('the popover opens', isOpen('dialog-popover'));

      const input = lab('dialog-popover-input');
      input.focus();
      await wait(RENDER_MS);
      check(
        "the dialog's focus trap leaves focus in the popover",
        document.activeElement === input,
        describe(document.activeElement)
      );

      const list = lab('dialog-popover-list');
      list.scrollTop = 0;
      check(
        "the dialog's scroll lock lets the popover scroll",
        !wheel(list).defaultPrevented
      );
      check(
        'the scroll lock still blocks the page behind',
        wheel(lab('heading')).defaultPrevented
      );

      const dialog = lab('dialog');
      const own = describedBy(dialog);
      const description = lab('dialog-description').id;
      check(
        "the dialog keeps the caller's aria-describedby and adds its description",
        own.includes('ui-lab-dialog-extra') && own.includes(description),
        own.join(' ')
      );

      escape(input);
      await wait(RENDER_MS);
      check('Escape closes the popover first', !isOpen('dialog-popover'));
      check('and leaves the dialog open', isOpen('dialog'));
      check('the popover finishes closing', await untilGone('dialog-popover'));
      await closeDialog();
      check('a second Escape closes the dialog', !isOpen('dialog'));
    },
  },
  {
    title: 'Popover outside press',
    run: async (check) => {
      resetProbes();
      lab('outside-trigger').click();
      await wait(RENDER_MS + LAYER_MS);
      check('the popover opens', isOpen('outside-popover'));
      press(lab('outside-plain'));
      await wait(RENDER_MS);
      check('a press outside closes it', !isOpen('outside-popover'));
      check(
        'and the pressed button still acts',
        probes.outsideClicks === 1,
        `${probes.outsideClicks} clicks`
      );

      lab('outside-trigger').click();
      await wait(RENDER_MS + LAYER_MS);
      press(lab('outside-stopper'));
      await wait(RENDER_MS);
      check(
        'a press on a control that stops its click leaves it open',
        isOpen('outside-popover')
      );
      escape(lab('outside-popover'));
      await wait(RENDER_MS);
      check('Escape closes it', !isOpen('outside-popover'));
    },
  },
  {
    title: 'Tooltip describes its trigger',
    run: async (check) => {
      const trigger = lab('tooltip-trigger');
      trigger.focus();
      await wait(RENDER_MS);
      const ids = describedBy(trigger);
      check(
        "the trigger keeps the caller's aria-describedby and adds the tooltip",
        ids.includes('ui-lab-tooltip-extra') && ids.length > 1,
        ids.join(' ')
      );
      trigger.blur();
      await wait(RENDER_MS);
    },
  },
  {
    title: 'Form controls: user changes bubble, programmatic ones do not',
    run: async (check) => {
      const form = lab('form');

      resetProbes();
      lab('form-checkbox').click();
      await wait(RENDER_MS);
      check(
        'a checkbox click reaches the form from its form input',
        probes.formEvents.includes('click:input[checkbox]'),
        probes.formEvents.join(', ')
      );

      resetProbes();
      lab('form-switch').click();
      await wait(RENDER_MS);
      check(
        'a switch click reaches the form from its form input',
        probes.formEvents.includes('click:input[checkbox]'),
        probes.formEvents.join(', ')
      );

      resetProbes();
      const thumb =
        lab('form-slider').querySelector<HTMLElement>('[role="slider"]');
      if (!thumb) throw new Error('the slider has no thumb');
      thumb.focus();
      thumb.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true })
      );
      await wait(RENDER_MS);
      check(
        'a slider key press reaches the form as input',
        probes.formEvents.some((e) => e.startsWith('input:')),
        probes.formEvents.join(', ')
      );

      resetProbes();
      const before = useLab.getState().sliderValue[0];
      useLab.setState({ sliderValue: [before === 40 ? 60 : 40] });
      await wait(RENDER_MS);
      check(
        'a programmatic slider change does not',
        !probes.formEvents.some((e) => e.startsWith('input:')),
        probes.formEvents.join(', ')
      );

      resetProbes();
      const next = useLab.getState().selectValue === 'a' ? 'b' : 'a';
      useLab.setState({ selectValue: next });
      await wait(RENDER_MS);
      const native = form.querySelector('select');
      check(
        'a programmatic select change reaches the form input',
        native?.value === next,
        native?.value ?? 'no <select>'
      );
      check(
        'but no change event reaches the form',
        !probes.formEvents.some((e) => e.startsWith('change:')),
        probes.formEvents.join(', ')
      );
    },
  },
  {
    title: 'Tabs: the old panel blurs before it unmounts',
    run: async (check) => {
      resetProbes();
      const input = lab('tab-input');
      input.focus();
      lab('tab-b').dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
      await wait(RENDER_MS);
      check(
        'the second tab is active',
        lab('tab-b').dataset.state === 'active'
      );
      check(
        "the first panel's input saw blur",
        probes.tabInputBlurs === 1,
        `${probes.tabInputBlurs} blurs`
      );
      check(
        'focus is on the new tab',
        document.activeElement === lab('tab-b'),
        describe(document.activeElement)
      );
      lab('tab-a').dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
      await wait(RENDER_MS);
    },
  },
  {
    title: "Direction: every primitive reads the app's provider",
    run: async (check) => {
      for (const name of ['scroll-element', 'tabs', 'form-slider']) {
        const dir = lab(name).getAttribute('dir');
        check(`${name} is rtl`, dir === 'rtl', dir ?? 'no dir');
      }
      lab('menu-trigger').dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
      await wait(RENDER_MS);
      const menu = find('menu');
      check('the menu opens', menu?.dataset.state === 'open');
      check(
        'the menu is rtl',
        menu?.getAttribute('dir') === 'rtl',
        menu?.getAttribute('dir') ?? 'no dir'
      );
      if (menu) escape(menu);
      await wait(RENDER_MS);
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
      await closeDialog();
    }
  }
  useLab.setState({ running: null });
}
