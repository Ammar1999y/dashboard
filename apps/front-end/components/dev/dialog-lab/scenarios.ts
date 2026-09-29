import Router from 'next/router';

import {
  closeAllDialogs,
  isDialogEntry,
  restoreDialogsFromUrl,
} from '@/lib/dialogs';
import { writeUrl } from '@/lib/history';

import { LAB_PATH, labInner, labLocal, labOuter, labRecord } from './dialogs';
import { useLab } from './lab-store';

type Check = (check: string, ok: boolean, detail?: string) => void;

export interface Scenario {
  title: string;
  run: (check: Check) => Promise<void>;
}

const RENDER_MS = 100;
const POP_SETTLE_MS = 50;
// The side sheets animate out over 300ms; Radix returns focus after that.
const EXIT_MS = 600;
const ROUTE_TIMEOUT_MS = 10_000;
const MAX_RESET_STEPS = 20;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const nextPop = () =>
  new Promise<void>((resolve) =>
    addEventListener('popstate', () => setTimeout(resolve, POP_SETTLE_MS), {
      once: true,
    })
  );

const nextRoute = () =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('no routeChangeComplete')),
      ROUTE_TIMEOUT_MS
    );
    const done = () => {
      clearTimeout(timeout);
      Router.events.off('routeChangeComplete', done);
      setTimeout(resolve, RENDER_MS);
    };
    Router.events.on('routeChangeComplete', done);
  });

const modules = () => new URLSearchParams(location.search).getAll('module');
const onDialogEntry = () => isDialogEntry(history.state);
const isShown = (lab: string) =>
  document.querySelector(
    `[data-lab="${CSS.escape(lab)}"][data-state="open"]`
  ) !== null;
const settingsShown = () =>
  [...document.querySelectorAll('[role="dialog"][data-state="open"]')].some(
    (el) => el.textContent?.includes('التخصيص')
  );
const byId = (id: string) => {
  const el = document.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!el) throw new Error(`#${id} is not on the page`);
  return el;
};
const within = (lab: string, selector: string) => {
  const el = document.querySelector<HTMLElement>(
    `[data-lab="${CSS.escape(lab)}"] ${selector}`
  );
  if (!el) throw new Error(`${selector} is not in the ${lab} dialog`);
  return el;
};

async function back() {
  const popped = nextPop();
  history.back();
  await popped;
}

async function forward() {
  const popped = nextPop();
  history.forward();
  await popped;
}

/** A close from the UI pops the dialog's own entry when it has one. */
async function uiClose(close: () => void) {
  const popped = onDialogEntry() ? nextPop() : null;
  close();
  await popped;
  await wait(RENDER_MS);
}

/** Taps like a finger: Radix dismisses on the click that follows. */
function tap(el: HTMLElement) {
  const init = { bubbles: true, button: 0, pointerType: 'touch' } as const;
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.click();
}

const expectClean = (check: Check) => {
  check('URL lists no dialog', modules().length === 0, location.search);
  check('back on the page entry, no dead entry left', !onDialogEntry());
};

async function reset() {
  closeAllDialogs();
  for (let i = 0; i < MAX_RESET_STEPS && onDialogEntry(); i++) await back();
  if (location.pathname === LAB_PATH) {
    writeUrl('replaceState', new URL(LAB_PATH, location.origin));
  }
  await wait(EXIT_MS);
}

export const SCENARIOS: Scenario[] = [
  {
    title: 'X closes it and removes its entry, every time',
    run: async (check) => {
      for (let i = 1; i <= 3; i++) {
        labOuter.open();
        await wait(RENDER_MS);
        check(`#${i} open, in the URL`, isShown('outer'), location.search);
        check(`#${i} has its own entry`, onDialogEntry());
        await uiClose(() => within('outer', '[data-lab-close]').click());
        check(`#${i} closed`, !isShown('outer'));
        expectClean(check);
      }
    },
  },
  {
    title: 'Back closes it and stays on the page',
    run: async (check) => {
      labOuter.open();
      await wait(RENDER_MS);
      await back();
      check('closed', !isShown('outer'));
      check('still on the lab page', location.pathname === LAB_PATH);
      expectClean(check);
    },
  },
  {
    title: 'Nested: back closes the most recent first',
    run: async (check) => {
      labOuter.open();
      await wait(RENDER_MS);
      within('outer', '[data-lab-open-inner]').click();
      await wait(RENDER_MS);
      check(
        'both in the URL, in order',
        modules().join(',') === 'lab-outer,lab-inner',
        location.search
      );
      await back();
      check('inner closed', !isShown('inner'));
      check('outer still open', isShown('outer'));
      check('URL lists outer only', modules().join(',') === 'lab-outer');
      await back();
      check('outer closed', !isShown('outer'));
      expectClean(check);
    },
  },
  {
    title: 'Nested: closing the outer one first keeps one entry per dialog',
    run: async (check) => {
      labOuter.open();
      labInner.open();
      await wait(RENDER_MS);
      await uiClose(labOuter.close);
      check('inner still open', isShown('inner'));
      check('URL lists inner only', modules().join(',') === 'lab-inner');
      await back();
      check('inner closed by one back', !isShown('inner'));
      expectClean(check);
    },
  },
  {
    title: 'Settings open, then the side sheet tapped (the phone bug)',
    run: async (check) => {
      byId('lab-settings-toggle').click();
      await wait(RENDER_MS);
      check('settings open', settingsShown());
      tap(byId('lab-side-toggle'));
      // Longer than the old 300ms refocus that used to close the sheet.
      await wait(EXIT_MS * 2);
      check('settings closed', !settingsShown());
      check('side sheet stayed open', isShown('side'));
      check(
        'focus is inside the side sheet',
        document
          .querySelector('[data-lab="side"]')
          ?.contains(document.activeElement) === true,
        document.activeElement?.tagName
      );
      check(
        'URL lists the side sheet only',
        modules().join(',') === 'lab-side'
      );
      await back();
      check('one back closes the side sheet', !isShown('side'));
      expectClean(check);
    },
  },
  {
    title: 'Settings toggle closes it again',
    run: async (check) => {
      byId('lab-settings-toggle').click();
      await wait(RENDER_MS);
      tap(byId('lab-settings-toggle'));
      await wait(EXIT_MS);
      check('closed, not reopened', !settingsShown());
      expectClean(check);
    },
  },
  {
    title: 'A payload dialog keeps its content while it animates out',
    run: async (check) => {
      labRecord.open({ id: 1, name: 'Record 1' });
      await wait(RENDER_MS);
      const text = () =>
        document.querySelector('[data-lab="record"]')?.textContent ?? '';
      check('shows record 1', text().includes('Record 1'));
      const popped = nextPop();
      labRecord.close();
      await wait(POP_SETTLE_MS);
      check('still shows record 1 on the way out', text().includes('Record 1'));
      await popped;
      await wait(EXIT_MS);
      labRecord.open({ id: 2, name: 'Record 2' });
      await wait(RENDER_MS);
      check('shows record 2', text().includes('Record 2'));
      await uiClose(labRecord.close);
      expectClean(check);
    },
  },
  {
    title: 'Forward never reopens a closed dialog',
    run: async (check) => {
      labOuter.open();
      await wait(RENDER_MS);
      await back();
      await forward();
      await wait(RENDER_MS);
      check('still closed', !isShown('outer'));
      check('URL lists no dialog', modules().length === 0, location.search);
    },
  },
  {
    title: 'A dialog outside the URL never touches history',
    run: async (check) => {
      const { href } = location;
      const { length } = history;
      labLocal.open();
      await wait(RENDER_MS);
      check('open', isShown('local'));
      await uiClose(labLocal.close);
      check('URL unchanged', location.href === href);
      check('no entry added', history.length === length);
    },
  },
  {
    title: 'Shared link: one entry per dialog, a payload one is dropped',
    run: async (check) => {
      writeUrl(
        'replaceState',
        new URL(
          `${LAB_PATH}?module=lab-outer&module=lab-inner&module=lab-record`,
          location.origin
        )
      );
      restoreDialogsFromUrl();
      await wait(RENDER_MS);
      check('outer and inner open', isShown('outer') && isShown('inner'));
      check('record not opened', !isShown('record'));
      check(
        'URL lists what opened',
        modules().join(',') === 'lab-outer,lab-inner',
        location.search
      );
      await back();
      check('first back closes inner', !isShown('inner') && isShown('outer'));
      await back();
      check('second back closes outer', !isShown('outer'));
      expectClean(check);
    },
  },
  {
    title: 'Focus returns to the button that opened it',
    run: async (check) => {
      const button = byId('lab-open-outer');
      button.focus();
      button.click();
      await wait(RENDER_MS);
      await uiClose(() => within('outer', '[data-lab-close]').click());
      await wait(EXIT_MS);
      check(
        'focus is back on the button',
        document.activeElement === button,
        document.activeElement?.id || document.activeElement?.tagName
      );
    },
  },
  {
    title: 'A link to a URL naming dialogs opens them',
    run: async (check) => {
      const arrived = nextRoute();
      void Router.push(`${LAB_PATH}?module=lab-outer&module=lab-inner`);
      await arrived;
      check('outer and inner open', isShown('outer') && isShown('inner'));
      check(
        'URL lists both',
        modules().join(',') === 'lab-outer,lab-inner',
        location.search
      );
      await back();
      check('first back closes inner', !isShown('inner') && isShown('outer'));
      await back();
      check('second back closes outer', !isShown('outer'));
      check('still on the lab page', location.pathname === LAB_PATH);
      expectClean(check);
    },
  },
  {
    title: 'A link inside a dialog, then back: one press returns',
    run: async (check) => {
      labOuter.open();
      await wait(RENDER_MS);
      const left = nextRoute();
      within('outer', '[data-lab-link]').click();
      await left;
      check('on /dash', location.pathname === '/dash', location.pathname);
      const returned = nextRoute();
      history.back();
      await returned;
      check(
        'one back is on the lab page',
        location.pathname === LAB_PATH,
        location.pathname
      );
      check('dialog closed', !isShown('outer'));
      expectClean(check);
    },
  },
];

export async function runScenarios(scenarios: Scenario[]) {
  if (useLab.getState().running) return;
  useLab.setState({ results: [] });
  try {
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
        await reset();
        await scenario.run(check);
      } catch (error) {
        check('ran to the end', false, String(error));
      }
    }
    await reset();
  } finally {
    useLab.setState({ running: null });
  }
}
