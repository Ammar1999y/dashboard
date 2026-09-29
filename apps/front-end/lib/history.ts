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
  if (method === 'replaceState' && url.href === location.href) return;
  history[method](state, '', url);
}

/**
 * Next's `key` and `as` on an entry, which together name one navigation.
 * `key` alone does not: `router.replace` keeps it across pages.
 */
function readPage(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  if (!('key' in state) || !('as' in state)) return undefined;
  const { key, as } = state;
  return typeof key === 'string' && typeof as === 'string'
    ? `${key} ${as}`
    : undefined;
}

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
