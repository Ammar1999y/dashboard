import { create } from 'zustand';
import { isSamePageEntry, trackPageEntry, writeUrl } from '@/lib/history';

// The values appear in shared links; renaming one breaks them.
export const DIALOG_URL_IDS = {
  imageZoom: 'image-zoom',
  themeCustomizer: 'theme-customizer',
  mobileMenu: 'mobile-menu',
  // `/dev/dialog-lab` only.
  labOuter: 'lab-outer',
  labInner: 'lab-inner',
  labSide: 'lab-side',
  labRecord: 'lab-record',
} as const;

type DialogUrlId = (typeof DIALOG_URL_IDS)[keyof typeof DIALOG_URL_IDS];

const URL_PARAM = 'module';
const URL_IDS: ReadonlySet<string> = new Set(Object.values(DIALOG_URL_IDS));
const isUrlId = (value: string): value is DialogUrlId => URL_IDS.has(value);

interface OpenDialog {
  urlId: DialogUrlId | undefined;
  /** Closes without writing history. */
  hide: () => void;
}

/**
 * Open dialogs, oldest first. `open` and `close` push and remove their own
 * entry, so this cannot drift from the dialogs' state; `?module=` is written
 * from it in this order.
 */
const openDialogs: OpenDialog[] = [];

/**
 * How a shared link opens a dialog. A dialog registers when its module loads,
 * so one first loaded after `restoreDialogsFromUrl` runs is skipped.
 */
const restorers = new Map<DialogUrlId, () => void>();

const readUrlIds = () => [
  ...new Set(
    new URL(location.href).searchParams.getAll(URL_PARAM).filter(isUrlId)
  ),
];

function withoutParam(state: object, field: 'as' | 'url') {
  const value: unknown = Reflect.get(state, field);
  if (typeof value !== 'string') return {};
  const url = new URL(value, location.origin);
  url.searchParams.delete(URL_PARAM);
  return { [field]: `${url.pathname}${url.search}${url.hash}` };
}

// Set on the entries an opening pushes, which closing pops again.
const ENTRY_FLAG = '__dialog';

export const isDialogEntry = (state: unknown) =>
  typeof state === 'object' &&
  state !== null &&
  ENTRY_FLAG in state &&
  state[ENTRY_FLAG] === true;

/** Pops that `close` started, which the popstate they fire must not undo. */
let pendingBacks = 0;

function openDialogsUrl() {
  const url = new URL(location.href);
  url.searchParams.delete(URL_PARAM);
  for (const { urlId } of openDialogs) {
    if (urlId) url.searchParams.append(URL_PARAM, urlId);
  }
  return url;
}

function pushDialogEntry() {
  // Hydration's own `replace` fires no route event, so the page is recorded
  // here too, from the entry about to be copied.
  trackPageEntry();
  const state: unknown = history.state;
  const base = typeof state === 'object' && state !== null ? state : {};
  writeUrl('pushState', openDialogsUrl(), { ...base, [ENTRY_FLAG]: true });
}

/** Rewrites the current entry to what is open, keeping its state. */
const replaceDialogEntry = () => writeUrl('replaceState', openDialogsUrl());

/**
 * Takes a closed dialog's entry off. The top entry goes, whichever dialog
 * pushed it, and the one below is rewritten to what is still open: every open
 * dialog keeps one entry, so back always closes the most recent one.
 */
function popDialogEntry() {
  if (isDialogEntry(history.state)) {
    pendingBacks += 1;
    history.back();
  } else {
    replaceDialogEntry();
  }
}

/**
 * Opens the dialogs the URL names, after landing or a navigation. Their params
 * come off first and go back on as each one opens, so each gets its own entry
 * and back closes it instead of leaving the page. Chrome's back button skips
 * entries pushed before the user has interacted with the page, so after a
 * landing it still leaves until the first tap.
 */
export function restoreDialogsFromUrl(): void {
  const ids = readUrlIds();
  if (ids.length === 0) return;
  // Next's own copy of the landing URL goes too, or returning here from
  // another page would route back to it and put the params back.
  const state: unknown = history.state;
  writeUrl(
    'replaceState',
    openDialogsUrl(),
    typeof state === 'object' && state !== null
      ? {
          ...state,
          ...withoutParam(state, 'as'),
          ...withoutParam(state, 'url'),
        }
      : state
  );
  trackPageEntry();
  for (const id of ids) restorers.get(id)?.();
}

/**
 * For a popstate. On another page's entry it does nothing: Next navigates, and
 * the route change closes everything. On this page's, it closes the dialogs
 * the entry does not list; it never opens one, since a forward entry can list
 * a dialog closed since. The entry is then rewritten to what is open.
 */
export function syncDialogsWithUrl(): void {
  if (pendingBacks > 0) {
    pendingBacks -= 1;
    replaceDialogEntry();
    return;
  }
  if (!isSamePageEntry(history.state)) return;
  const ids = readUrlIds();
  const stale = openDialogs.filter(
    ({ urlId }) => urlId && !ids.includes(urlId)
  );
  for (const dialog of stale) dialog.hide();
  replaceDialogEntry();
}

/**
 * For Next's `beforePopState`: whether Next should route this pop. An entry of
 * the page on screen is the dialogs' own. A dialog entry of a page left since,
 * say through a link in the menu, is skipped on the way back to that page's
 * own entry, or it would take a second press to get past.
 */
export function shouldRoutePop(state: unknown): boolean {
  if (isSamePageEntry(state)) return false;
  if (!isDialogEntry(state)) return true;
  history.back();
  return false;
}

/** For a page change, which owns the URL: nothing is written to history. */
export function closeAllDialogs(): void {
  pendingBacks = 0;
  while (openDialogs.length > 0) openDialogs[0].hide();
}

// The optional `never` keeps `open` from being handed straight to `onClick`,
// where the click event would become the payload. Wrap it: `() => open()`.
type OpenArgs<T> = void extends T ? [guard?: never] : [payload: T];

interface DialogOptions<T> {
  /** Mirrors the dialog into `?module=`, so the back button closes it. */
  urlId?: DialogUrlId;
  /**
   * Lets a shared link open it. A URL carries no payload, so only a dialog
   * without one can opt in.
   */
  restoreFromUrl?: void extends T ? boolean : never;
}

/** The part `StoreDialog` binds, which does not depend on the payload. */
export interface DialogControls {
  useIsOpen: () => boolean;
  setOpen: (open: boolean) => void;
  restoreFocus: (event: { preventDefault(): void }) => void;
}

export interface DialogStore<T> extends DialogControls {
  open: (...args: OpenArgs<T>) => void;
  close: () => void;
  /**
   * What to render. Held through the exit animation, so derive `open` from
   * `useIsOpen`, never from this.
   */
  usePayload: () => T | null;
  /** The live payload, `null` once closed. For handlers, which never render. */
  getPayload: () => T | null;
}

/**
 * One dialog's state. The payload is the single source of truth for "open":
 * opening and closing are one state change, not two kept in step. It is
 * wrapped so that `void` and a falsy payload still read as open.
 */
export function createDialog<T = void>(
  options: DialogOptions<T> = {}
): DialogStore<T> {
  const { urlId, restoreFromUrl } = options;

  const useStore = create<{
    state: { payload: T } | null;
    // Survives `close`: the dialog is still on screen while it animates out,
    // and clearing it there blanks the body for the length of the exit.
    rendered: T | null;
  }>(() => ({ state: null, rendered: null }));

  // Radix returns focus only to a `DialogTrigger`, and these open from
  // anywhere, so the element focused when it opened stands in for one.
  let opener: HTMLElement | null = null;

  const entry: OpenDialog = { urlId, hide };

  function hide(): boolean {
    const index = openDialogs.indexOf(entry);
    if (index !== -1) openDialogs.splice(index, 1);
    useStore.setState({ state: null });
    return index !== -1;
  }

  function show(payload: T) {
    const isOpening = !openDialogs.includes(entry);
    if (isOpening) {
      openDialogs.push(entry);
      const focused = document.activeElement;
      opener =
        focused instanceof HTMLElement && focused !== document.body
          ? focused
          : null;
    }
    useStore.setState({ state: { payload }, rendered: payload });
    if (isOpening && urlId) pushDialogEntry();
  }

  const close = () => {
    const wasOpen = hide();
    if (wasOpen && urlId) popDialogEntry();
  };

  if (urlId && restoreFromUrl) {
    // `restoreFromUrl` type-checks only when `T` is `void`.
    restorers.set(urlId, () => show(undefined as T));
  }

  return {
    open: (...args) => show(args[0] as T),
    close,
    // Radix reports `true` only from a `DialogTrigger`; these open via `open`.
    setOpen: (next) => {
      if (!next) close();
    },
    useIsOpen: () => useStore((s) => s.state !== null),
    // Not `??`: a payload that is `null` while open must not fall through to
    // what the dialog showed last time.
    usePayload: () => useStore((s) => (s.state ? s.state.payload : s.rendered)),
    getPayload: () => {
      const { state } = useStore.getState();
      return state ? state.payload : null;
    },
    restoreFocus: (event) => {
      const target = opener;
      opener = null;
      if (!target?.isConnected) return;
      event.preventDefault();
      // Focus that a click outside moved elsewhere stays there.
      const focused = document.activeElement;
      if (!focused || focused === document.body) target.focus();
    },
  };
}
