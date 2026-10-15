# Data table

The list table behind every dashboard list page: server-paged (`users`, `permissions`), or loaded whole and paged in the browser.

Read this before changing anything here, or anything it depends on outside this folder: the column files of each feature, `store/url-store.ts`, `lib/api/query.ts`, `lib/data-table/query.ts`, `lib/data-table/url.ts`, `lib/history.ts`, `mocks/lib/data-table.ts`, `styles/table.css` and `@app/shared/data-table/*`. Most rules below exist because breaking them once made the header or rows stop updating, or made the table slow at 100 rows.

## Using it

```tsx
<DataTable
  title='المستخدمين'
  cta={{ href: '/dash/users/new', label: 'إضافة مستخدم جديد' }}
  columns={columns}
  queryKey={USERS_QUERY_KEYS.list}
  href='/api/dash/users'
  storageKey='users-table'
  serverSide // omit when the endpoint returns the whole list
/>
```

Build columns from the presets in `index.ts` (`textColumn`, `statusColumn`, `dateColumn`, `actionsColumn`) and the actions column from `rowActionsColumn` in `components/dash/shared/row-actions.tsx`. A hand-written column is a plain TanStack `ColumnDef`; its table options live on `meta` (`column-meta.ts`). The header defaults to `meta.label`.

`defaultSort` falls back to `createdAt` descending when that column exists, and `defaultPinning` falls back to the `actions` column pinned to the end.

## How state flows

There are two stores, and they own different things:

| State                                    | Owner                                                                                  | Lifetime                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| page, page size, sort, filters, search   | `useDataTableStore` (`store/url-store.ts`), mirrored to the URL by `mirrorTableToUrl`  | one module singleton, bound to the route and navigation by `initTable` |
| column order, visibility, pinning, sizes | the column store (`store/column-store.ts`), saved to `localStorage` under `storageKey` | one per mounted `DataTableView`                                        |

- `DataTable` picks the data source: the server one, or `queryRows` over the whole list (`lib/data-table/query.ts`, which the mocks use too). It then renders `DataTableView`.
- `DataTableView` creates the column store and renders the frame.
- `hooks/use-table-instance.ts` is the only place `useReactTable` is called. TanStack does no paging, sorting or filtering here (`manual*`): rows arrive ready, and TanStack only lays out columns.
- Column changes go through the store actions (`useColumnActions()`): `setVisible`, `pin`, `move`, `drop`, `resetSize`, `reset`. TanStack's resize handler writes through `onColumnSizingChange`, which is the same store.

The URL store is bound to one visit (the route, the history entry the table mounted on, and Next's `asPath`), so a route holds **one** `DataTable`, and every visit, Back to an earlier one included, starts from its own URL.

The URL holds the query in the keys `@app/shared` names (`DATA_TABLE_PARAMS`); `lib/data-table/url.ts` reads it with the server's parser (`parseTableParams`) and writes it, for the address and for the request alike. The address is written through `lib/history.ts` (see `components/dialogs/README.md`, rules 13 to 15), which also keeps it on the entry for Back. The search box applies its term through `filters/search-draft.ts`.

## Layout

| Path                                                        | What it holds                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `data-table.tsx`                                            | public `DataTable`: data source, default sort, remount per `storageKey`      |
| `data-table-view.tsx`                                       | column store, DnD context, toolbar, table frame, pagination                  |
| `hooks/use-table-instance.ts`                               | TanStack instance; derives `layout`, `bodyRows`, `columnRules`, `tableWidth` |
| `hooks/use-column-dnd.ts`                                   | header drag-and-drop sensors and handlers                                    |
| `components/header*.tsx`                                    | header row, header cell (sort, filter, resize, drag), column menu            |
| `components/body.tsx`                                       | rows and cells with their memo comparators; skeleton, error and empty states |
| `components/column-rules.tsx`                               | one `<style>` per column: width, visibility, pin offset                      |
| `components/table-elements.tsx`                             | `TableRow`, `TableCell`, `cellAttributes`                                    |
| `store/`                                                    | column store, its React context, `localStorage` load and save                |
| `view-options.tsx`                                          | the "العرض" popover: show/hide, reorder, reset                               |
| `filters/`                                                  | search box and its draft, filter and sort lists, column filter popover       |
| `column-presets.tsx`, `column-header.tsx`, `column-meta.ts` | column helpers, default header, `ColumnMeta` augmentation                    |

## Rules that keep the UI in sync

1. **Render from what `useTableInstance` returns, never from `table`.** `table` keeps one identity for its whole life. React Compiler caches a component by its props, so a component that renders from `table` (`table.getHeaderGroups()`, `row.getVisibleCells()`, `column.getIsPinned()` in JSX) renders once and then freezes. That is how the header and rows used to stop updating. Use `table` only inside event handlers.
2. **Only `use-table-instance.ts` calls TanStack getters for rendering.** Each derived value has a memo whose dependencies are TanStack's own memoized values (`headerGroups`, the three leaf-column zones). Add a new derived value the same way. Don't pull it through `table` and hide the dependency behind an `eslint-disable`.
3. **The column store lives in a `useState` initializer.** Don't make it a module singleton: one table's unmount used to wipe the next table's layout. Don't use `useMemo` either: React may drop a memo. To load another layout, remount the view (`key`).
4. **Cell renderers read only from their row.** A row whose record is unchanged skips rendering and keeps its old cells (`sameRow` in `body.tsx`). A cell that shows outside state (a store, a context) must subscribe to it inside its own component.
5. **Keep the keys:** rows by record id (`getRowId`), cells and headers by column id. Index keys make a sort rewrite other records' DOM, and make the memo comparators compare the wrong records.
6. **Keep stable references stable:** `NO_ROWS`, the module-level `coreRowModel`, `DEFAULT_COLUMN`. A new array or function each render is new input to TanStack, which rebuilds every row.

## Rules that keep it fast

Measured in a production build at 100 rows, the most a page can show.

1. **Widths, visibility and pin offsets are CSS, in `ColumnRules`.** Each column has its own `<style>`, so only the column that changed is rewritten. Never put widths inline on cells, never as CSS variables on the table, and never in one shared sheet. A changed custom property restyles every element in the table, and a rewritten shared sheet restyles every cell. Both were measured at about 25 ms of style work per resize step, against about 5 ms now.
2. **The rules stay in column definition order.** Reordering `<style>` elements makes the browser restyle everything.
3. **Hidden columns keep their body cells, with `display:none`.** Removing a DOM node restyles the rest of its row: the app's global Tailwind `space-*` utilities are sibling selectors (`… > :not([hidden]) ~ …`). Keeping the cells makes hide and show a single rule change, with no row re-rendered. The header does drop the hidden column's cell, because TanStack builds headers only for visible columns.
4. **Moving a column reorders the DOM, on purpose.** CSS `order` would avoid re-rendering rows, but Tab order and screen readers would then follow the original column order instead of what's on screen. A move re-renders each row (a map over memoized cells), about 3–5 ms at 100 rows.
5. **A resize re-renders only the frame and that column's rule.** Nothing that depends on sizes may reach a header or body cell as a prop.

Expected renders per action; the lab's report shows them per event:

| Action                         | Renders                                      |
| ------------------------------ | -------------------------------------------- |
| resize                         | the frame, one `DataTableColumnRule`         |
| hide / show an unpinned column | the frame, the header, one rule; **no rows** |
| move                           | the header, every row; no cells              |
| pin / unpin                    | the header, every row, that column's cells   |
| refetch, one record changed    | that row and its cells                       |

## Verifying a change

Type-checking proves only that shapes line up. Use the lab at `/dev/data-table-lab` (`components/dev/data-table-lab/`):

- **What it runs:** it mounts `DataTableView` over a fake server, then drives it like a user: header menus, the view-options popover, real pointer drags, resize handles, filters, pagination, remounts.
- **What it checks:** after every step it compares the DOM with the table's state: header order, cell order and values, widths, pin offsets and edges, the column rules, pagination and saved layout. It also counts which components rendered.
- **How to run it:** press **Run all scenarios**; every event must report `ok`. For performance work, compare the "Scale — 100 rows" group before and after the change.

Measure performance on a profiling production build, not in `next dev`:

```sh
NEXT_PUBLIC_API_MOCKING=enabled bun --bun next build --profile --webpack
bun run start:mock   # http://localhost:3123/dev/data-table-lab
```

`--profile` keeps React's Profiler working in production, which the lab's render timings need. After the lab, open the list pages in mock mode and check that they render without console errors.
