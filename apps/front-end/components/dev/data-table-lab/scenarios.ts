import type { LabRow } from './fake-server';
import type { NoteFn } from './recorder';
import type { Mismatch } from './types';
import type { DataTableFeatures } from '@/components/ui/data-table';
import type { ColumnStore } from '@/components/ui/data-table/store/column-store';
import type { QueryClient } from '@tanstack/react-query';
import type { Table } from '@tanstack/react-table';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';

import { LAB_ACTIONS_COLUMN, labColumns } from './columns';
import { LAB_QUERY_KEY, labServer } from './fake-server';
import { LAB_STORAGE_KEY, useLab } from './lab-store';

export interface Scenario {
  title: string;
  run: (note: NoteFn) => void | Promise<void>;
  verify?: () => Mismatch[];
}

export interface ScenarioGroup {
  title: string;
  scenarios: Scenario[];
}

const WAIT_TIMEOUT_MS = 3000;
// Covers the persistence hook's rAF re-apply and its 500ms save that follows.
const TRACE_MS = 1200;
// `useTablePersistence` writes 500ms after the last column change.
const PERSIST_WAIT_MS = 800;

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, probe: () => T | null | undefined) {
  const deadline = performance.now() + WAIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    await frame();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const table = (): Table<DataTableFeatures, LabRow> => {
  const current = useLab.getState().table;
  if (!current) throw new Error('table not mounted');
  return current;
};

const root = (): HTMLElement => {
  const current = useLab.getState().root;
  if (!current) throw new Error('table root not mounted');
  return current;
};

const columnStore = (): ColumnStore => {
  const current = useLab.getState().store;
  if (!current) throw new Error('column store not mounted');
  return current;
};

// The same store actions the header menu and the drag handlers call.
const handlers = (columnId: string) => {
  const { actions } = columnStore().getState();
  return {
    hide: () => actions.setVisible(columnId, false),
    pinStart: () => actions.pin(columnId, 'start'),
    pinEnd: () => actions.pin(columnId, 'end'),
    unpin: () => actions.pin(columnId, false),
    moveLeft: () => actions.move(columnId, 'next'),
    moveToFarRight: () => actions.move(columnId, 'first'),
    moveToFarLeft: () => actions.move(columnId, 'last'),
  };
};

const headOf = (columnId: string) =>
  root()
    .querySelector(
      `[data-slot="table-header"] [data-lab-col="${CSS.escape(columnId)}"]`
    )
    ?.closest<HTMLElement>('[data-slot="table-head"]');

const click = (el: Element | null | undefined, what: string) => {
  if (!(el instanceof HTMLElement)) throw new Error(`${what} not found`);
  el.click();
};

const viewOptionsTrigger = () =>
  [...root().querySelectorAll(':scope [role="toolbar"] button')].find((b) =>
    b.textContent?.includes('العرض')
  );

const viewOptionsItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
    (item) =>
      (
        item.querySelector('.truncate')?.textContent ?? item.textContent
      )?.trim() === text
  );

const isViewOptionsOpen = () =>
  !!document.querySelector('input[placeholder="بحث عن عمود..."]');

async function openViewOptions() {
  if (isViewOptionsOpen()) return;
  click(viewOptionsTrigger(), 'view-options trigger');
  await waitFor('view-options popover', isViewOptionsOpen);
}

async function closeViewOptions() {
  if (!isViewOptionsOpen()) return;
  click(viewOptionsTrigger(), 'view-options trigger');
  await waitFor('view-options to close', () => !isViewOptionsOpen());
}

const pointer = (clientX: number, clientY: number, buttons: number) => ({
  bubbles: true,
  cancelable: true,
  clientX,
  clientY,
  pointerId: 1,
  pointerType: 'mouse',
  isPrimary: true,
  button: 0,
  buttons,
});

// A browser fires both families; dnd-kit's Pointer and Mouse sensors each
// listen to one of them.
function press(
  el: Element | Document,
  kind: 'down' | 'move' | 'up',
  x: number,
  y: number
) {
  const buttons = kind === 'up' ? 0 : 1;
  el.dispatchEvent(new PointerEvent(`pointer${kind}`, pointer(x, y, buttons)));
  el.dispatchEvent(new MouseEvent(`mouse${kind}`, pointer(x, y, buttons)));
}

/** A real drag from `handle` to the middle of `target`, through dnd-kit's sensors. */
async function pointerDrag(handle: Element, target: Element) {
  const from = handle.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const x = from.left + from.width / 2;
  const y = from.top + from.height / 2;
  const targetY = to.top + to.height / 2;
  press(handle, 'down', x, y);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await frame();
    press(document, 'move', x, y + ((targetY - y) * i) / steps);
  }
  await frame();
  await frame();
  press(document, 'up', x, targetY);
}

// React tracks an input's value itself: set it through the native setter so
// the `input` event reaches `onChange`, as real typing does.
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * With rows scrolled under the sticky header, what is painted at each header
 * cell must be the header itself — pinned body cells carry their own z-index.
 */
function checkHeaderOnTop(): Mismatch[] {
  const container = root().querySelector<HTMLElement>(
    ':scope [data-slot="table-container"]'
  );
  if (!container) return [{ check: 'header on top', detail: 'no container' }];
  const out: Mismatch[] = [];
  if (container.scrollTop === 0)
    out.push({
      check: 'header on top',
      detail: 'rows did not scroll, so the check could not run',
    });
  const visible = container.getBoundingClientRect();
  for (const head of container.querySelectorAll<HTMLElement>(
    '[data-slot="table-head"]'
  )) {
    const rect = head.getBoundingClientRect();
    const centre = rect.left + rect.width / 2;
    // A cell scrolled out of the container's width is painted by nothing.
    if (centre < visible.left || centre > visible.right) continue;
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    if (hit && !hit.closest('[data-slot="table-header"]'))
      out.push({
        check: 'header on top',
        detail: `${head.querySelector<HTMLElement>('[data-lab-col]')?.dataset.labCol ?? '?'}${head.dataset.pinned ? ` (pinned ${head.dataset.pinned})` : ''}: covered by ${hit.closest<HTMLElement>('[data-slot]')?.dataset.slot ?? hit.tagName}`,
      });
  }
  container.scrollTop = 0;
  return out;
}

const gripOf = (item: Element | undefined) =>
  item?.querySelector<HTMLElement>('[data-slot="sortable-item-handle"]') ??
  undefined;

// What the header drag's `onDragEnd` calls.
const dragColumn = (activeId: string, overId: string) =>
  columnStore().getState().actions.drop(activeId, overId);

// A stale header may not render the name column at all; the store call then
// still exercises the data path, with the same asc → desc → asc cycle as
// `SortButton`.
function sortByName(note: NoteFn) {
  const button = headOf('name')?.querySelector<HTMLElement>('[data-sort]');
  if (button) {
    button.click();
    return;
  }
  note(
    'name header is not in the DOM (stale header): sorted through the store'
  );
  const { sort, actions } = useDataTableStore.getState();
  const current = sort.find((s) => s.id === 'name');
  actions.setSorting([{ id: 'name', desc: current ? !current.desc : false }]);
}

async function dragResize(columnId: string, deltaPx: number) {
  const handle = headOf(columnId)?.querySelector('.resize-handler');
  if (!handle) throw new Error(`resize handle of ${columnId} not found`);
  const rect = handle.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  handle.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y })
  );
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    await frame();
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: x - (deltaPx * i) / steps,
        clientY: y,
      })
    );
  }
  document.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      clientX: x - deltaPx,
      clientY: y,
    })
  );
}

const expectSize = (columnId: string, expected: number): Mismatch[] => {
  const actual = table().getColumn(columnId)?.getSize();
  return actual === expected
    ? []
    : [
        {
          check: 'scenario expectation',
          detail: `${columnId} size ${actual}, expected ${expected}`,
        },
      ];
};

interface LayoutSnapshot {
  order: string;
  hidden: string;
  pinStart: string;
  pinEnd: string;
  sizes: string;
}

const snapshotLayout = (): LayoutSnapshot => {
  const t = table();
  const state = t.store.state;
  return {
    order: state.columnOrder.join(','),
    hidden: Object.entries(state.columnVisibility)
      .filter(([, visible]) => !visible)
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b))
      .join(','),
    pinStart: state.columnPinning.start.join(','),
    pinEnd: state.columnPinning.end.join(','),
    sizes: t
      .getAllLeafColumns()
      .map((c) => `${c.id}:${c.getSize()}`)
      .join(','),
  };
};

const diffLayout = (before: LayoutSnapshot, after: LayoutSnapshot) =>
  (Object.keys(before) as (keyof LayoutSnapshot)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      check: 'persistence',
      detail: `${key}: before remount "${before[key]}", after "${after[key]}"`,
    }));

const hiddenIds = (visibility: Record<string, boolean>) =>
  Object.entries(visibility)
    .filter(([, visible]) => !visible)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b))
    .join(',');

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

const asStringList = (value: unknown) =>
  Array.isArray(value) ? value.map(String).join(',') : '(none)';

const readSaved = (): Record<string, unknown> | null => {
  const raw = localStorage.getItem(LAB_STORAGE_KEY);
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
};

const summarizeSaved = (saved: Record<string, unknown> | null) =>
  saved
    ? `order [${asStringList(saved.columnOrder)}] · hidden [${hiddenIds(asRecord(saved.columnVisibility) as Record<string, boolean>)}] · sizing ${Object.keys(asRecord(saved.columnSizing)).length} keys`
    : 'nothing saved';

const domHeaderIds = () =>
  [
    ...(useLab
      .getState()
      .root?.querySelectorAll<HTMLElement>(
        ':scope [data-slot="table-header"] [data-lab-col]'
      ) ?? []),
  ]
    .map((el) => el.dataset.labCol)
    .join(',');

/**
 * Logs, with timestamps, every write to the column stores, each change of the
 * registered table instance, the header DOM per frame and each save to
 * storage — the order these happen in across one unmount and mount.
 */
function traceLifecycle(note: NoteFn) {
  const start = performance.now();
  const lines: string[] = [];
  const log = (text: string) => {
    lines.push(`+${Math.round(performance.now() - start)}ms ${text}`);
  };
  const initialTable = useLab.getState().table;

  // Each table instance owns its store, so the watch moves to the new one.
  const watchStore = (store: ColumnStore | null) =>
    store?.subscribe((s, previous) => {
      if (s.columnOrder !== previous.columnOrder)
        log(`columnOrder ← [${s.columnOrder.join(',')}]`);
      if (s.columnVisibility !== previous.columnVisibility)
        log(`columnVisibility ← hidden [${hiddenIds(s.columnVisibility)}]`);
      if (s.columnPinning !== previous.columnPinning)
        log(
          `columnPinning ← start[${s.columnPinning.start.join(',')}] end[${s.columnPinning.end.join(',')}]`
        );
      if (s.columnSizing !== previous.columnSizing)
        log(`columnSizing ← ${JSON.stringify(s.columnSizing)}`);
    });
  let unwatchStore = watchStore(useLab.getState().store);

  const unsubscribes = [
    useLab.subscribe((s, previous) => {
      if (s.store !== previous.store) {
        unwatchStore?.();
        unwatchStore = watchStore(s.store);
        if (s.store) {
          const { columnOrder, columnPinning } = s.store.getState();
          log(
            `new column store, first state: order [${columnOrder.join(',')}] · pinned end[${columnPinning.end.join(',')}]`
          );
        }
      }
      if (s.table === previous.table) return;
      if (!s.table) log('table unregistered (old table unmounted)');
      else if (s.table === initialTable) log('table re-registered (same)');
      else log('table registered (new instance)');
    }),
    () => unwatchStore?.(),
  ];

  let frameCount = 0;
  let lastDom = domHeaderIds();
  let lastSaved = localStorage.getItem(LAB_STORAGE_KEY);
  let handle = 0;
  const sample = () => {
    frameCount++;
    const dom = domHeaderIds();
    if (dom !== lastDom) log(`frame ${frameCount}: header DOM [${dom}]`);
    lastDom = dom;
    const saved = localStorage.getItem(LAB_STORAGE_KEY);
    if (saved !== lastSaved)
      log(`frame ${frameCount}: saved ${summarizeSaved(readSaved())}`);
    lastSaved = saved;
    handle = requestAnimationFrame(sample);
  };
  handle = requestAnimationFrame(sample);

  return async () => {
    await sleep(Math.max(0, TRACE_MS - (performance.now() - start)));
    cancelAnimationFrame(handle);
    for (const unsubscribe of unsubscribes) unsubscribe();
    note(`lifecycle trace over ${frameCount} frames:`);
    for (const line of lines) note(`  ${line}`);
  };
}

// A remount builds a new column store from storage, exactly as a page load does.
async function remount(note: NoteFn) {
  const previous = useLab.getState().table;
  const stopTrace = traceLifecycle(note);
  useLab.setState((s) => ({ mountKey: s.mountKey + 1 }));
  await waitFor('remounted table', () => {
    const current = useLab.getState().table;
    return current && current !== previous ? current : null;
  });
  await stopTrace();
}

const DEFAULT_ORDER = labColumns.flatMap((c) => (c.id ? [c.id] : []));

const isDefaultLayout = () => {
  const state = columnStore().getState();
  return (
    state.columnOrder.join(',') === DEFAULT_ORDER.join(',') &&
    hiddenIds(state.columnVisibility) === '' &&
    state.columnPinning.start.length === 0 &&
    state.columnPinning.end.join(',') === LAB_ACTIONS_COLUMN &&
    Object.keys(state.columnSizing).length === 0
  );
};

/**
 * Storage must hold the layout the table shows, or the next visit restores
 * something else. A default layout is not saved at all.
 */
function checkSaved(): Mismatch[] {
  const saved = readSaved();
  if (!saved)
    return isDefaultLayout()
      ? []
      : [{ check: 'saved layout', detail: 'custom layout was not saved' }];
  const t = table();
  const state = t.store.state;
  const out: Mismatch[] = [];

  const order = asStringList(saved.columnOrder);
  if (order !== state.columnOrder.join(','))
    out.push({
      check: 'saved layout',
      detail: `order saved [${order}], table [${state.columnOrder.join(',')}]`,
    });

  const hidden = hiddenIds(
    asRecord(saved.columnVisibility) as Record<string, boolean>
  );
  if (hidden !== hiddenIds(state.columnVisibility))
    out.push({
      check: 'saved layout',
      detail: `hidden saved [${hidden}], table [${hiddenIds(state.columnVisibility)}]`,
    });

  // Every column the user resized keeps its width, hidden or not.
  const sizing = asRecord(saved.columnSizing);
  const drift = t
    .getAllLeafColumns()
    .filter((c) => sizing[c.id] !== state.columnSizing[c.id])
    .map(
      (c) =>
        `${c.id} saved ${String(sizing[c.id] ?? '(none)')} vs ${String(state.columnSizing[c.id] ?? '(none)')}`
    );
  if (drift.length > 0)
    out.push({ check: 'saved layout', detail: `sizing: ${drift.join('; ')}` });
  return out;
}

/** A first visit must end on the column defaults, in the store as well as on screen. */
function checkDefaultStores(): Mismatch[] {
  const { columnOrder, columnPinning, columnVisibility } =
    columnStore().getState();
  const out: Mismatch[] = [];
  if (columnOrder.join(',') !== DEFAULT_ORDER.join(','))
    out.push({
      check: 'default layout',
      detail: `columnOrder [${columnOrder.join(',')}], expected [${DEFAULT_ORDER.join(',')}]`,
    });
  const end = columnPinning.end.join(',');
  if (end !== LAB_ACTIONS_COLUMN)
    out.push({
      check: 'default layout',
      detail: `end pinning [${end}], expected [${LAB_ACTIONS_COLUMN}]`,
    });
  if (hiddenIds(columnVisibility) !== '')
    out.push({
      check: 'default layout',
      detail: `hidden [${hiddenIds(columnVisibility)}], expected none`,
    });
  return out;
}

const verifyPersistence = (before: LayoutSnapshot | null) => [
  ...(before ? diffLayout(before, snapshotLayout()) : []),
  ...checkSaved(),
];

export function createScenarioGroups(
  queryClient: QueryClient
): ScenarioGroup[] {
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [LAB_QUERY_KEY] });
  const actions = () => useDataTableStore.getState().actions;
  let persisted: LayoutSnapshot | null = null;
  let resizeStart = 0;
  let orderBeforeDrag: string[] = [];

  return [
    {
      title: 'Baseline',
      scenarios: [
        {
          title: 'reset server, URL state and storage, then remount',
          run: async (note) => {
            localStorage.removeItem(LAB_STORAGE_KEY);
            labServer.reset();
            actions().setSearch('');
            actions().setPerPage(10);
            actions().setSorting([{ id: 'createdAt', desc: true }]);
            actions().setPage(1);
            await remount(note);
          },
          verify: () => [...checkDefaultStores(), ...checkSaved()],
        },
      ],
    },
    {
      title: 'Visibility',
      scenarios: [
        {
          title: 'hide email — header menu handler',
          run: () => handlers('email').hide(),
        },
        {
          title: 'open view-options popover',
          run: openViewOptions,
        },
        {
          title: 'show email — click view-options item',
          run: () => click(viewOptionsItem('email'), 'view-options item email'),
        },
        {
          title: 'hide score while popover is open — header menu handler',
          run: () => handlers('score').hide(),
        },
        {
          title: 'hide notes — click view-options item',
          run: () => click(viewOptionsItem('notes'), 'view-options item notes'),
        },
        {
          title: 'show all — click view-options item',
          run: () => click(viewOptionsItem('اظهار الكل'), '"show all" item'),
        },
        {
          title: 'close view-options popover',
          run: closeViewOptions,
        },
      ],
    },
    {
      title: 'Ordering',
      scenarios: [
        {
          title: 'move name one step — header menu "الى اليسار"',
          run: () => handlers('name').moveLeft(),
        },
        {
          title: 'move notes to far start — header menu "الى اقصى اليمين"',
          run: () => handlers('notes').moveToFarRight(),
        },
        {
          title:
            'drop email onto score — header DnD handler (no activeIndex change here)',
          run: () => dragColumn('email', 'score'),
        },
        {
          title:
            'reorder while view-options is open (popover order must follow)',
          run: async () => {
            await openViewOptions();
            handlers('status').moveToFarLeft();
          },
        },
        {
          title: 'drag score onto name in view-options — real pointer drag',
          run: async () => {
            await openViewOptions();
            orderBeforeDrag = columnStore().getState().columnOrder;
            const target = viewOptionsItem('name');
            const handle = gripOf(viewOptionsItem('score'));
            if (!handle || !target)
              throw new Error('view-options items not found');
            await pointerDrag(handle, target);
          },
          verify: () => {
            const order = columnStore().getState().columnOrder;
            const expected = orderBeforeDrag.indexOf('name');
            return order.indexOf('score') === expected
              ? []
              : [
                  {
                    check: 'scenario expectation',
                    detail: `score at ${order.indexOf('score')} in [${order.join(',')}], expected ${expected}`,
                  },
                ];
          },
        },
        {
          title: 'close view-options popover',
          run: closeViewOptions,
        },
      ],
    },
    {
      title: 'Pinning',
      scenarios: [
        {
          title: 'pin name to start — header menu "يمين"',
          run: () => handlers('name').pinStart(),
        },
        {
          title: 'drop status onto pinned name — joins the pin zone',
          run: () => dragColumn('status', 'name'),
        },
        {
          title:
            'resize pinned name to 300 — offsets of next pinned column must move',
          run: () => table().setColumnSizing((old) => ({ ...old, name: 300 })),
          verify: () => expectSize('name', 300),
        },
        {
          title: 'unpin status',
          run: () => handlers('status').unpin(),
        },
        {
          title: 'unpin name',
          run: () => handlers('name').unpin(),
        },
        {
          title: 'pin role to end — header menu "يسار"',
          run: () => handlers('role').pinEnd(),
        },
        {
          title: 'hide pinned role',
          run: () => handlers('role').hide(),
        },
        {
          title: 'show role again — view-options item',
          run: async () => {
            await openViewOptions();
            click(viewOptionsItem('role'), 'view-options item role');
          },
        },
        {
          title: 'close view-options popover',
          run: closeViewOptions,
        },
      ],
    },
    {
      title: 'Sizing',
      scenarios: [
        {
          title: 'drag-resize email by 80px — real resize handle',
          run: async () => {
            resizeStart = table().getColumn('email')?.getSize() ?? 0;
            await dragResize('email', 80);
          },
          verify: () => expectSize('email', resizeStart + 80),
        },
        {
          title: 'double-click email resize handle — reset size',
          run: () => {
            const handle = headOf('email')?.querySelector('.resize-handler');
            if (!handle) throw new Error('resize handle of email not found');
            handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          },
          verify: () => expectSize('email', 220),
        },
        {
          title: 'set notes to 400 — table.setColumnSizing',
          run: () => table().setColumnSizing((old) => ({ ...old, notes: 400 })),
          verify: () => expectSize('notes', 400),
        },
      ],
    },
    {
      title: 'Data',
      scenarios: [
        {
          title: 'row action "score +1" on the first row — refetch',
          run: () =>
            click(
              root().querySelector(':scope [data-lab-cell="actions"] button'),
              'first row action'
            ),
        },
        {
          title: 'refetch identical data',
          run: invalidate,
        },
        {
          title: 'next page — click pagination',
          run: () =>
            click(
              root().querySelector('button[aria-label="الصفحة التالية"]'),
              'next page button'
            ),
        },
        {
          title: 'page size 25 — same calls as the page-size select',
          run: () => {
            actions().setPage(1);
            actions().setPerPage(25);
          },
        },
        {
          title:
            'scroll rows under the sticky header — pinned cells must stay beneath it',
          run: async () => {
            const container = root().querySelector<HTMLElement>(
              ':scope [data-slot="table-container"]'
            );
            if (!container) throw new Error('table container not found');
            container.scrollTop = 120;
            await frame();
            await frame();
          },
          verify: checkHeaderOnTop,
        },
        {
          title: 'sort by name — click header sort button',
          run: (note) => sortByName(note),
        },
        {
          title: 'sort by name again (flip direction)',
          run: (note) => sortByName(note),
        },
        {
          title: 'column filter: type "User 1" into the name filter and apply',
          run: async () => {
            click(
              headOf('name')?.querySelector('[data-column-filter]'),
              'name filter button'
            );
            const input = await waitFor('filter input', () =>
              document.querySelector<HTMLInputElement>(
                '[data-radix-popper-content-wrapper] input[aria-label$="filter value"]'
              )
            );
            typeInto(input, 'User 1');
            await frame();
            click(
              [
                ...document.querySelectorAll<HTMLElement>(
                  '[data-radix-popper-content-wrapper] button'
                ),
              ].find((b) => b.textContent?.trim() === 'تطبيق'),
              'apply button'
            );
          },
          verify: () => {
            const filter = useDataTableStore
              .getState()
              .filters.find((f) => f.id === 'name');
            return filter?.value === 'User 1'
              ? []
              : [
                  {
                    check: 'scenario expectation',
                    detail: `name filter value ${JSON.stringify(filter?.value)}, expected "User 1"`,
                  },
                ];
          },
        },
        {
          title: 'clear filters',
          run: () => actions().setFilters([]),
        },
        {
          title: 'search "User 0" — same call the search box commits',
          run: () => actions().setSearch('User 0'),
        },
        {
          title: 'search with no match — empty state',
          run: () => actions().setSearch('zzz'),
        },
        {
          title: 'clear search',
          run: () => actions().setSearch(''),
        },
        {
          title: 'server error while cached rows exist',
          run: async () => {
            labServer.setMode('error');
            await invalidate();
          },
        },
        {
          title: 'server recovers',
          run: async () => {
            labServer.setMode('ok');
            await invalidate();
          },
        },
        {
          title: 'server returns an empty result',
          run: async () => {
            labServer.setMode('empty');
            await invalidate();
          },
        },
        {
          title: 'server returns rows again',
          run: async () => {
            labServer.setMode('ok');
            await invalidate();
          },
        },
      ],
    },
    {
      title: 'Persistence & lifecycle',
      scenarios: [
        {
          title: 'reset columns — click view-options "إعادة ضبط الاعمدة"',
          run: async () => {
            await openViewOptions();
            click(viewOptionsItem('إعادة ضبط الاعمدة'), '"reset columns" item');
          },
        },
        {
          title: 'resize notes to 300, wait for save — storage must match',
          run: async () => {
            table().setColumnSizing((old) => ({ ...old, notes: 300 }));
            await sleep(PERSIST_WAIT_MS);
          },
          verify: checkSaved,
        },
        {
          title: 'change layout, wait for save, remount — layout must survive',
          run: async (note) => {
            handlers('notes').hide();
            handlers('email').pinStart();
            handlers('score').moveToFarLeft();
            table().setColumnSizing((old) => ({ ...old, name: 260 }));
            await sleep(PERSIST_WAIT_MS);
            persisted = snapshotLayout();
            await remount(note);
          },
          verify: () => verifyPersistence(persisted),
        },
        {
          title: 'remount again with nothing changed',
          run: async (note) => {
            persisted = snapshotLayout();
            await remount(note);
          },
          verify: () => verifyPersistence(persisted),
        },
        {
          title:
            'first visit: clear storage, remount — stores must hold the defaults',
          run: async (note) => {
            localStorage.removeItem(LAB_STORAGE_KEY);
            await remount(note);
          },
          verify: () => [...checkDefaultStores(), ...checkSaved()],
        },
        {
          title:
            'page reload with a saved custom layout — header must show the saved layout',
          run: async (note) => {
            handlers('notes').hide();
            handlers('email').pinStart();
            handlers('score').moveToFarLeft();
            table().setColumnSizing((old) => ({ ...old, name: 260 }));
            await sleep(PERSIST_WAIT_MS);
            persisted = snapshotLayout();
            await remount(note);
          },
          verify: () => verifyPersistence(persisted),
        },
      ],
    },
    {
      title: 'Scale — 100 rows on one page',
      scenarios: [
        {
          title: 'load 100 rows, page size 100',
          run: async () => {
            labServer.seed(100);
            actions().setPage(1);
            actions().setPerPage(100);
            await invalidate();
          },
        },
        {
          title: '100 rows: hide email',
          run: () => handlers('email').hide(),
        },
        {
          title: '100 rows: move name one step',
          run: () => handlers('name').moveLeft(),
        },
        {
          title: '100 rows: pin name to start',
          run: () => handlers('name').pinEnd(),
        },
        {
          title: '100 rows: unpin name',
          run: () => handlers('name').unpin(),
        },
        {
          title: '100 rows: reset columns',
          run: () => columnStore().getState().actions.reset(),
        },
        {
          title: '100 rows: refetch with one changed row',
          run: async () => {
            labServer.bumpScore('r100');
            await invalidate();
          },
        },
        {
          title: '100 rows: drag-resize email by 80px',
          run: async () => {
            resizeStart = table().getColumn('email')?.getSize() ?? 0;
            await dragResize('email', 80);
          },
          verify: () => expectSize('email', resizeStart + 80),
        },
        {
          title: '100 rows: pin email, then drag-resize it by 80px',
          run: async () => {
            handlers('email').pinEnd();
            await frame();
            resizeStart = table().getColumn('email')?.getSize() ?? 0;
            await dragResize('email', 80);
          },
          verify: () => expectSize('email', resizeStart + 80),
        },
        {
          title: 'back to 57 rows, page size 10',
          run: async () => {
            labServer.reset();
            columnStore().getState().actions.reset();
            actions().setPerPage(10);
            await invalidate();
          },
        },
      ],
    },
  ];
}
