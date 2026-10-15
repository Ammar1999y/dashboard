import type { NextRouter } from 'next/router';

type PageParamsWriter = (params: URLSearchParams) => void;

/** Each writer with the page it was registered on, the only one it writes. */
const pageParams = new Map<PageParamsWriter, string | undefined>();

function applyPageParams(params: URLSearchParams): void {
  const page = readPage(history.state);
  for (const [write, owner] of pageParams) if (owner === page) write(params);
}

/**
 * Next's `as` and `url` on the entry, with the page's params. Next routes a
 * pop onto another page's entry from them and rewrites the address to `as`,
 * so without this, Back to a page drops what it wrote since it was opened.
 * Next reads the entry's state only on a pop: writing it renders nothing.
 */
function withPageParams(state: unknown): unknown {
  if (typeof state !== 'object' || state === null || pageParams.size === 0)
    return state;
  const next: Record<string, unknown> = { ...state };
  for (const field of ['as', 'url'] as const) {
    const value: unknown = Reflect.get(state, field);
    if (typeof value !== 'string') continue;
    const target = new URL(value, location.origin);
    applyPageParams(target.searchParams);
    next[field] = `${target.pathname}${target.search}${target.hash}`;
  }
  return next;
}

const nextField = (state: unknown, field: 'as' | 'url'): unknown =>
  typeof state === 'object' && state !== null
    ? Reflect.get(state, field)
    : undefined;

/**
 * Changes the URL without a Next navigation. Next's state has to stay on the
 * entry: popping onto one without it makes Next stamp the page being left with
 * this URL instead of navigating back to it.
 */
export function writeUrl(
  method: 'pushState' | 'replaceState',
  url: URL,
  state: unknown = history.state
) {
  const next = withPageParams(state);
  if (
    method === 'replaceState' &&
    url.href === location.href &&
    nextField(next, 'as') === nextField(history.state, 'as') &&
    nextField(next, 'url') === nextField(history.state, 'url')
  )
    return;
  history[method](next, '', url);
}

/**
 * Next's `key` and the path of its `as` on an entry, which together name one
 * navigation. `key` alone does not: `router.replace` keeps it across pages.
 * The query is left out because the page rewrites it (`withPageParams`); a
 * `router.replace` that changes only the query therefore stays the same page.
 */
function readPage(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  if (!('key' in state) || !('as' in state)) return undefined;
  const { key, as } = state;
  return typeof key === 'string' && typeof as === 'string'
    ? `${key} ${new URL(as, location.origin).pathname}`
    : undefined;
}

/**
 * Registers a part of the page that keeps its state in the address, written
 * from its live state whenever the page's URL is. Dialog entries are written
 * through it, so the entry under a dialog carries what changed while it was
 * open, not what the address said when it opened.
 */
export function registerPageParams(write: PageParamsWriter): () => void {
  pageParams.set(write, readPage(history.state));
  return () => {
    pageParams.delete(write);
  };
}

/** The address with every registered part's current state. */
export function pageUrl(): URL {
  const url = new URL(location.href);
  applyPageParams(url.searchParams);
  return url;
}

let pending: ReturnType<typeof setTimeout> | undefined;

/**
 * Writes the scheduled URL now. On another page's entry, which Back may have
 * reached since, it writes nothing: no part of the page being left writes
 * there.
 */
export function flushPageUrl(): void {
  if (pending === undefined) return;
  clearTimeout(pending);
  pending = undefined;
  writeUrl('replaceState', pageUrl());
}

/** Writes the page's URL once `delayMs` pass without another call. */
function schedulePageUrl(delayMs: number): void {
  clearTimeout(pending);
  pending = setTimeout(flushPageUrl, delayMs);
}

interface MirroredPart {
  write: PageParamsWriter;
  /** Calls back on every change to the part's state. */
  subscribe: (onChange: () => void) => () => void;
  /** How long changes must pause before the address is written. */
  delayMs: number;
}

const written = (write: PageParamsWriter) => {
  const params = new URLSearchParams();
  write(params);
  return params.toString();
};

/**
 * Keeps a part's state in the address until the returned stop. It starts
 * from the address, so only a later change is written; a change that leaves
 * the part's params as they were writes nothing.
 */
export function mirrorPageParams({
  write,
  subscribe,
  delayMs,
}: MirroredPart): () => void {
  const unregister = registerPageParams(write);
  let last = written(write);
  const unsubscribe = subscribe(() => {
    const next = written(write);
    if (next === last) return;
    last = next;
    schedulePageUrl(delayMs);
  });
  return () => {
    unsubscribe();
    flushPageUrl();
    unregister();
  };
}

/** The navigation the current entry belongs to; `undefined` on the server. */
export const entryPage = (): string | undefined =>
  typeof history === 'undefined' ? undefined : readPage(history.state);

let currentPage: string | undefined;

/** Records the entry the page on screen was navigated to. */
export function trackPageEntry(): void {
  currentPage = readPage(history.state);
}

/**
 * Whether a popped entry belongs to the page on screen: one written by
 * `writeUrl`, which copies Next's state. Next must leave such a pop alone, or
 * it re-runs the route and rewrites the entry's URL to the page's own.
 */
export function isSamePageEntry(state: unknown): boolean {
  const page = readPage(state);
  return page !== undefined && page === currentPage;
}

/** What Next's router treats as a route change that was called off rather than one that failed. */
const cancelledChange = () =>
  Object.assign(new Error('Route change cancelled'), { cancelled: true });

/**
 * Thrown from `routeChangeStart`, the only way to stop a Next route change.
 * Next throws it on out of a promise neither `<Link>` nor its popstate handler
 * awaits, so it is always an unhandled rejection: not an `Error`, which
 * Next's dev overlay reports, and marked handled (`handleCalledOffRouteChanges`).
 */
const CALLED_OFF = Object.freeze({ cancelled: true });

/** Calls off the route change to `url`, from a `routeChangeStart` listener. */
export function callOffRouteChange(
  events: NextRouter['events'],
  url: string
): never {
  events.emit('routeChangeError', cancelledChange(), url);
  throw CALLED_OFF;
}

/** Keeps a called-off route change out of the console, until the returned stop. */
export function handleCalledOffRouteChanges(): () => void {
  const onRejection = (event: PromiseRejectionEvent) => {
    if (event.reason === CALLED_OFF) event.preventDefault();
  };
  addEventListener('unhandledrejection', onRejection);
  return () => removeEventListener('unhandledrejection', onRejection);
}
