import type { LabRow } from './fake-server';
import type { Mismatch } from './types';
import type { DataTableFeatures } from '@/components/ui/data-table';
import type { Column, Table } from '@tanstack/react-table';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';

import { displayValue, LAB_ACTIONS_COLUMN } from './columns';

export interface LabTableStatus {
  isLoading: boolean;
  hasError: boolean;
  dataLength: number;
  pageCount: number;
}

const WIDTH_TOLERANCE_PX = 1;
const MAX_ROW_REPORTS = 3;

const list = (ids: string[]) => `[${ids.join(', ')}]`;

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const width = (el: Element) => Math.round(el.getBoundingClientRect().width);

const expectedPinPosition = (column: Column<DataTableFeatures, LabRow>) => {
  const pinned = column.getIsPinned();
  if (pinned === 'start') return `${column.getStart('start')}px`;
  if (pinned === 'end') return `${column.getAfter('end')}px`;
  return '';
};

function checkPinning(
  out: Mismatch[],
  where: string,
  el: HTMLElement,
  column: Column<DataTableFeatures, LabRow>
) {
  const pinned = column.getIsPinned();
  const domPinned = el.dataset.pinned ?? false;
  if (domPinned !== pinned)
    out.push({
      check: `${where} pinning`,
      detail: `${column.id}: data-pinned=${String(domPinned)}, expected ${String(pinned)}`,
    });
  if (!pinned) return;

  // `styles/table.css` offsets a start-pinned column from the right (RTL) and
  // an end-pinned one from the left; the computed value resolves the variables.
  const computed = getComputedStyle(el);
  const position = pinned === 'start' ? computed.right : computed.left;
  const expected = expectedPinPosition(column);
  if (position !== expected)
    out.push({
      check: `${where} pin offset`,
      detail: `${column.id}: offset ${position || '(unset)'}, expected ${expected}`,
    });

  const isEdge =
    pinned === 'start'
      ? column.getIsLastColumn('start')
      : column.getIsFirstColumn('end');
  const domEdge =
    el.dataset[pinned === 'start' ? 'isLastPinned' : 'isFirstPinned'] ===
    'true';
  if (isEdge !== domEdge)
    out.push({
      check: `${where} pin edge`,
      detail: `${column.id}: edge shadow=${String(domEdge)}, expected ${String(isEdge)}`,
    });
}

function checkHeaders(
  out: Mismatch[],
  table: Table<DataTableFeatures, LabRow>,
  root: HTMLElement
) {
  const headerRoot = root.querySelector('[data-slot="table-header"]');
  if (!headerRoot) {
    out.push({ check: 'header', detail: 'header region not rendered' });
    return;
  }
  const headers = table.getHeaderGroups().slice(-1)[0]?.headers ?? [];
  const markers = [
    ...headerRoot.querySelectorAll<HTMLElement>('[data-lab-col]'),
  ];
  const expectedIds = headers.map((h) => h.column.id);
  const domIds = markers.map((m) => m.dataset.labCol ?? '?');
  if (!sameList(expectedIds, domIds))
    out.push({
      check: 'header order',
      detail: `dom ${list(domIds)} ≠ table ${list(expectedIds)}`,
    });

  const sort = useDataTableStore.getState().sort;
  for (const header of headers) {
    const el = headerRoot
      .querySelector(`[data-lab-col="${CSS.escape(header.column.id)}"]`)
      ?.closest<HTMLElement>('[data-slot="table-head"]');
    if (!el) continue;

    const domWidth = width(el);
    if (Math.abs(domWidth - header.getSize()) > WIDTH_TOLERANCE_PX)
      out.push({
        check: 'header width',
        detail: `${header.column.id}: dom ${domWidth}px, expected ${header.getSize()}px`,
      });
    checkPinning(out, 'header', el, header.column);

    if (!header.column.getCanSort()) continue;
    const current = sort.find((s) => s.id === header.column.id);
    const expected = current ? (current.desc ? 'desc' : 'asc') : 'none';
    const shown =
      el.querySelector<HTMLElement>('[data-sort]')?.dataset.sort ?? 'missing';
    if (shown !== expected)
      out.push({
        check: 'sort icon',
        detail: `${header.column.id}: shows ${shown}, expected ${expected}`,
      });
  }
}

type BodyKind = 'rows' | 'skeleton' | 'error' | 'empty' | 'none';

function domBodyKind(body: Element): BodyKind {
  if (body.querySelector('[data-lab-cell]')) return 'rows';
  if (body.querySelector('.animate-pulse')) return 'skeleton';
  if (body.querySelector('.text-red-600')) return 'error';
  if (body.querySelector('[data-slot="table-row"]')) return 'empty';
  return 'none';
}

function checkBody(
  out: Mismatch[],
  table: Table<DataTableFeatures, LabRow>,
  root: HTMLElement,
  status: LabTableStatus
) {
  const body = root.querySelector('[data-slot="table-body"]');
  if (!body) {
    out.push({ check: 'body', detail: 'body region not rendered' });
    return;
  }
  const modelRows = table.getRowModel().rows;
  const expectedKind: BodyKind =
    status.dataLength > 0 && modelRows.length > 0
      ? 'rows'
      : status.isLoading
        ? 'skeleton'
        : status.hasError
          ? 'error'
          : 'empty';
  const kind = domBodyKind(body);
  if (kind !== expectedKind) {
    out.push({
      check: 'body state',
      detail: `dom shows ${kind}, expected ${expectedKind}`,
    });
    return;
  }
  if (kind !== 'rows') return;

  const domRows = [...body.querySelectorAll('[data-slot="table-row"]')].filter(
    (r) => r.querySelector('[data-lab-cell]')
  );
  const domRowIds = domRows.map(
    (r) => r.querySelector<HTMLElement>('[data-lab-row]')?.dataset.labRow ?? '?'
  );
  const expectedRowIds = modelRows.map((r) => r.original.id);
  if (!sameList(domRowIds, expectedRowIds))
    out.push({
      check: 'row set',
      detail: `dom ${domRows.length} rows ${list(domRowIds.slice(0, 5))}… ≠ table ${modelRows.length} rows ${list(expectedRowIds.slice(0, 5))}…`,
    });

  let reported = 0;
  modelRows.forEach((row, index) => {
    const domRow = domRows[index];
    if (!domRow || reported >= MAX_ROW_REPORTS) return;
    // A hidden column keeps its cells, hidden by its column rule.
    const cells = [
      ...domRow.querySelectorAll<HTMLElement>('[data-lab-cell]'),
    ].filter((c) => c.checkVisibility());
    const domCols = cells.map((c) => c.dataset.labCell ?? '?');
    const expectedCells = row.getVisibleCells();
    const expectedCols = expectedCells.map((c) => c.column.id);
    if (!sameList(domCols, expectedCols)) {
      reported++;
      out.push({
        check: 'cell order',
        detail: `row ${row.original.id}: dom ${list(domCols)} ≠ table ${list(expectedCols)}`,
      });
      return;
    }
    for (const [i, cellEl] of cells.entries()) {
      const expectedCell = expectedCells[i];
      if (!expectedCell) continue;
      const columnId = expectedCell.column.id;
      if (cellEl.dataset.labRow !== row.original.id) {
        reported++;
        out.push({
          check: 'cell row',
          detail: `row ${row.original.id}: cell ${columnId} still shows row ${cellEl.dataset.labRow}`,
        });
        continue;
      }
      if (columnId === LAB_ACTIONS_COLUMN) continue;
      const expectedText = displayValue(row, columnId);
      if (cellEl.textContent === expectedText) {
        continue;
      }

      reported++;
      out.push({
        check: 'cell value',
        detail: `row ${row.original.id}.${columnId}: dom "${cellEl.textContent}", expected "${expectedText}"`,
      });
    }
  });

  const firstRow = domRows[0];
  const firstModelRow = modelRows[0];
  if (!firstRow || !firstModelRow) return;
  for (const cell of firstModelRow.getVisibleCells()) {
    const el = firstRow
      .querySelector(`[data-lab-cell="${CSS.escape(cell.column.id)}"]`)
      ?.closest<HTMLElement>('[data-slot="table-cell"]');
    if (!el) continue;
    const domWidth = width(el);
    if (Math.abs(domWidth - cell.column.getSize()) > WIDTH_TOLERANCE_PX)
      out.push({
        check: 'cell width',
        detail: `${cell.column.id}: dom ${domWidth}px, expected ${cell.column.getSize()}px`,
      });
    checkPinning(out, 'cell', el, cell.column);
  }
}

function checkPagination(
  out: Mismatch[],
  root: HTMLElement,
  status: LabTableStatus
) {
  const prev = root.querySelector<HTMLButtonElement>(
    'button[aria-label="الصفحة السابقة"]'
  );
  const next = root.querySelector<HTMLButtonElement>(
    'button[aria-label="الصفحة التالية"]'
  );
  if (!prev || !next) return;

  const page = useDataTableStore.getState().page;
  const current = root.querySelector('[aria-current="page"]')?.textContent;
  if (current !== String(page))
    out.push({
      check: 'pagination',
      detail: `active page button "${current ?? '(none)'}", store page ${page}`,
    });
  const canPrevious = page > 1;
  const canNext = page < status.pageCount;
  if (prev.disabled === canPrevious)
    out.push({
      check: 'pagination',
      detail: `prev disabled=${prev.disabled} on page ${page}`,
    });
  if (next.disabled === canNext)
    out.push({
      check: 'pagination',
      detail: `next disabled=${next.disabled} on page ${page} of ${status.pageCount}`,
    });
}

function checkLayout(
  out: Mismatch[],
  table: Table<DataTableFeatures, LabRow>,
  root: HTMLElement
) {
  const tableEl = root.querySelector<HTMLElement>('[data-slot="table"]');
  if (!tableEl) return;
  const total = table.getTotalSize();
  const domWidth = width(tableEl);
  if (Math.abs(domWidth - total) > WIDTH_TOLERANCE_PX)
    out.push({
      check: 'table width',
      detail: `table element ${domWidth}px, expected ${total}px`,
    });

  // One rule per column, hidden ones included: a hidden column's cells stay
  // mounted and its rule hides them.
  const sheets = [...root.querySelectorAll('style')].map(
    (el) => el.textContent
  );
  const drift = table.getAllLeafColumns().flatMap((c) => {
    const expected = c.getIsVisible()
      ? `width:${c.getSize()}px`
      : 'display:none';
    const found = sheets.filter((text) =>
      text.includes(`[data-column="${c.id}"]{`)
    );
    if (found.length === 1 && found[0]?.includes(expected)) return [];
    return [
      `${c.id}: ${found.join(' | ') || '(no rule)'}, expected ${expected}`,
    ];
  });
  if (drift.length > 0)
    out.push({ check: 'column rules', detail: drift.join('; ') });
}

// The popover is portalled, so it is looked up in the document, not the table root.
function checkViewOptions(
  out: Mismatch[],
  table: Table<DataTableFeatures, LabRow>
) {
  const input = document.querySelector('input[placeholder="بحث عن عمود..."]');
  const popover = input?.closest('[cmdk-root]');
  if (!popover) return;

  const items = [
    ...popover.querySelectorAll<HTMLElement>('[cmdk-item]'),
  ].filter((item) => item.querySelector('.truncate'));
  const labelToId = new Map(
    table.getAllLeafColumns().flatMap((c) => [
      [c.id, c.id],
      [c.columnDef.meta?.label ?? c.id, c.id],
    ])
  );
  const domIds = items.map((item) => {
    const text = item.querySelector('.truncate')?.textContent ?? '';
    return labelToId.get(text) ?? `?${text}`;
  });

  const order = table.store.state.columnOrder;
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? Infinity : index;
  };
  const expectedIds = table
    .getAllLeafColumns()
    .map((c) => c.id)
    .sort((a, b) => rank(a) - rank(b));
  if (!sameList(domIds, expectedIds))
    out.push({
      check: 'view-options order',
      detail: `popover ${list(domIds)} ≠ columnOrder ${list(expectedIds)}`,
    });

  for (const [i, item] of items.entries()) {
    const id = domIds[i];
    const column = id ? table.getColumn(id) : undefined;
    if (!column) continue;
    const checked = !!item.querySelector('.bg-primary');
    if (checked !== column.getIsVisible())
      out.push({
        check: 'view-options check',
        detail: `${column.id}: checkbox=${checked}, visible=${column.getIsVisible()}`,
      });
  }
}

export function runChecks(
  table: Table<DataTableFeatures, LabRow>,
  root: HTMLElement,
  status: LabTableStatus
): Mismatch[] {
  const out: Mismatch[] = [];
  checkHeaders(out, table, root);
  checkBody(out, table, root, status);
  checkPagination(out, root, status);
  checkLayout(out, table, root);
  checkViewOptions(out, table);
  return out;
}
