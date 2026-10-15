# Dialogs

Every dialog the app opens from code: the settings panel, the mobile menu, image zoom, the editor's media upload, and any new one. Each dialog has its own small store (`createDialog` in `lib/dialogs.ts`), and a dialog given a `urlId` also lives in the URL (`?module=`) and in the browser history, so the back button closes it.

Read this before changing anything here, or anything it depends on outside this folder: `lib/dialogs.ts`, `lib/history.ts`, the `beforePopState` callback in `pages/_app.tsx`, the leave guard (`hooks/use-leave-guard.ts`), and the parts that keep their state in the URL through the same helpers: the data table (`mirrorTableToUrl` in `components/ui/data-table/store/url-store.ts`) and the media library (`components/dash/media/sync.tsx`). Nearly every rule below exists because breaking it once shipped a bug, listed next to it.

## Using it

```tsx
// A dialog without data, in the URL, opened by a shared link too.
export const settingsDialog = createDialog({
  urlId: DIALOG_URL_IDS.themeCustomizer,
  restoreFromUrl: true,
});

// A dialog that carries data. The URL cannot carry it, so no restoreFromUrl.
export const imageZoomDialog = createDialog<FileWithPreview>({
  urlId: DIALOG_URL_IDS.imageZoom,
});

// Render it anywhere; it opens from anywhere.
<StoreDialog dialog={settingsDialog} modal={false} side='left'>…</StoreDialog>
<DialogToggle dialog={settingsDialog} variant='ghost'>…</DialogToggle>
imageZoomDialog.open(file);
```

- `open(payload)` opens, `close()` closes. The payload is the open state: there is no separate `isOpen` to keep in step.
- `useIsOpen()` is for rendering the open state; `usePayload()` is what the body renders. `getPayload()` is the live payload for handlers (`null` once closed).
- Put the store in a file the opener can import cheaply (the feature's `store.ts`), not in the dialog component: the opener would pull the whole dialog into its bundle.
- A dialog that exists once per component instance (the editor's media dialog, one per toolbar) is created in `useState(() => createDialog<T>())` and gets no `urlId`. A module-level one would open in every instance on the page.
- A new `urlId` is added to `DIALOG_URL_IDS`. Its value appears in shared links, so renaming it breaks them.

## Layout

| Path                         | What it holds                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `lib/dialogs.ts`             | `createDialog`, the stack of open dialogs, everything that writes `?module=`          |
| `lib/history.ts`             | `writeUrl` (keeps Next's state), which page the current entry belongs to, page params |
| `store-dialog.tsx`           | binds a store to the Radix dialog; focus return                                       |
| `dialog-toggle.tsx`          | the trigger button for a dialog without data                                          |
| `dialog-close-button.tsx`    | the X button of the side sheets                                                       |
| `url-sync.tsx`               | popstate, route changes, restoring dialogs a URL names                                |
| `index.tsx`                  | the app-wide dialogs, mounted once from `_app`                                        |
| `image-zoom/`                | the image zoom dialog and its store                                                   |
| `reauth/`                    | the re-authentication prompt; its store and `requestReauth` are `lib/auth/reauth.ts`  |
| `components/dev/dialog-lab/` | the lab at `/dev/dialog-lab`                                                          |

## How history works

One rule holds everything together: **every open dialog with a `urlId` owns exactly one history entry, stacked in the order they opened.** The URL lists the open ids in the same order.

| What happens                                                                               | What the code does                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| a dialog opens                                                                             | pushes one entry, a copy of Next's state flagged `__dialog`                                                                                         |
| it closes from the UI (X, Escape, outside click)                                           | `history.back()` removes the top entry; the popstate that fires is counted (`pendingBacks`) and only rewrites the entry below to what is still open |
| the browser back button, same page                                                         | `_app` tells Next to leave the pop alone (`shouldRoutePop`); `syncDialogsWithUrl` closes what the entry no longer lists                             |
| a link or `router.push` to another page                                                    | Next pushes its entry; `routeChangeComplete` closes every dialog without touching history                                                           |
| a link to the page on screen that names only dialogs, or one followed from inside a dialog | called off (`startRouteChange`): the open dialogs close through their entries and the ones it names open, so no second entry of the page is left    |
| back onto a dialog entry of a page left since                                              | skipped on the way to that page's own entry, so one press is enough                                                                                 |
| landing on, or navigating to, a URL with `?module=`                                        | the params come off (Next's own `as` and `url` too), then each restorable dialog opens and pushes its entry                                         |

A page is identified by Next's `key` and the path of its `as` (`lib/history.ts`). `key` alone is not enough: `router.replace` keeps it across pages. The query is left out because the page rewrites it (rule 13). A link to the page on screen is the one navigation that keeps both: Next turns it into a replace of the current entry with the link's bare URL, and `completeRouteChange` writes the page's params back, since the page stays mounted with its state.

## Rules, and the bug each one fixed

1. **Write history only through `writeUrl`.** It keeps `history.state`. An entry written with `null` state makes Next, on popping back to it from another page, relabel the page on screen with that entry's URL instead of navigating: the address bar said one page while another was showing. Both the dialogs and the data-table URL sync did this.
2. **Touch only your own params.** The data-table sync rebuilt the URL from its own keys and erased `?module=` whenever a filter changed.
3. **Closing pops the entry, it does not replace it.** Replacing left a dead entry after every X: back then did nothing visible, once per dialog ever closed.
4. **A popstate never opens a dialog.** An older entry can list a dialog the user has closed since (settings closed while the menu was open on top). Reopening from it brought the settings back on the next back press.
5. **Next must not route a pop within the same page.** It re-runs the route and rewrites the entry's URL and state to the page's own, which erased `?module=` and the `__dialog` flag from the entry the user just landed on.
6. **Never unmount a dialog because it closed.** `{payload && <Dialog …>}` cuts the exit animation. The store keeps the last payload (`rendered`) so the body still has something to show while it animates out; derive `open` from `useIsOpen`, never from the payload.
7. **Return focus only when it fell to `<body>`.** The old trigger refocused its button 300 ms after close, unconditionally. With the settings open, tapping the menu button opened the menu, closed the settings, then moved focus to the settings button, outside the non-modal menu, and Radix closed the menu. Focus that the user moved somewhere else stays there.
8. **No `DialogTrigger`.** It only works inside the same `<Dialog>` tree, and these open from anywhere (the settings button is in the header, the panel is mounted in `_app`). `setOpen(true)` is ignored on purpose; opening always goes through `open`.
9. **Don't pass `open` straight to `onClick`** on a dialog without data: the click event would become the payload. The type refuses it; wrap it, `() => dialog.open()`.
10. **Only a dialog without data may `restoreFromUrl`.** A shared link carries no payload; the type refuses the option otherwise. Image zoom from a link is dropped from the URL instead of opening empty.
11. **A restorable dialog must be created in a module that loads before `url-sync.tsx` restores.** A dialog registers itself when its module loads; the app-wide ones live in the main bundle for this reason.
12. **Wait for `router.isReady` before restoring.** Until then Next's hydration `replace` can rewrite the current entry and drop the `__dialog` flag.
13. **A page part that keeps state in the URL mirrors it (`mirrorPageParams`), and every write goes through `writeUrl`, which puts the registered params into Next's `as` and `url` too.** Next routes Back onto another page's entry from those and rewrites the address to `as`: Back to a filtered table or an open folder came back to the URL the page was first opened with, while the table store still held the filters. Dialog entries are written through it as well, so the entry under a dialog gets what changed while it was open. A part writes only the page it was registered on: a page being left must not put its state on the next one's entry. Writing the entry's state renders nothing; Next reads it only on a pop.
14. **A delayed write (`schedulePageUrl`) writes only what the page on screen registered.** The table's write waited 300 ms and then wrote onto whatever entry was current: Back within that time put one page's filters on the previous page's URL. Writers are now scoped to their page (rule 13), so on another page's entry it writes nothing. Opening a dialog and starting a route change flush it first, so a link followed straight after a change still leaves it on the page's entry.
15. **A route change called off (`hooks/use-leave-guard.ts`) tells a pop from a link by the entry (`isSamePageEntry`), not the address, and goes forward `distanceToPage()`.** Comparing Next's `asPath` with the address took a link for a pop once the page had rewritten its own URL, and went forward onto whatever entry was there. Going forward one entry after a Back that skipped a dialog entry landed on that entry, which skipped back again: the prompt came back until the user gave in and left.
16. **A link to the page on screen that names only dialogs, or one followed from inside a dialog, is not a navigation.** Next pushed an entry of the same page for a URL with `?module=`, and turned a dialog's entry into one of the page for its bare URL: once the dialogs closed, Back showed the same page again. A bare link with nothing open is still Next's replace, after which `completeRouteChange` writes the page's params back.
17. **A route change is called off only through `callOffRouteChange`.** Throwing from `routeChangeStart` is the only way to stop one, and nothing awaits what Next throws on, so every cancel is an unhandled rejection. It throws a marker that is not an `Error`, which Next's dev overlay would show as a runtime error, and `DialogUrlSync` marks it handled (`handleCalledOffRouteChanges`).

## What the browser does, not the code

- **A shared link, then back straight away, leaves the page.** Chrome and Edge skip the history entries a page added before the user interacted with it, to stop pages trapping the back button. After one tap anywhere, back closes the dialogs one by one. A link clicked inside the app counts as that tap. Nothing a page can do changes this.
- **Safari does not focus a button on a mouse click**, so there is nothing to return focus to. Keyboard users do get focus back.
- **Forward onto a closed dialog's entry leaves it closed** (rule 4) and rewrites that entry, so one forward press shows nothing new.
- **Radix dismisses a dialog on the click after an outside press, not on the press itself.** That is why clicking a `DialogToggle` while its non-modal dialog is open closes it cleanly instead of closing and reopening it.

## Verifying a change

Type-checking proves only that shapes line up. Use the lab at `/dev/dialog-lab` (`components/dev/dialog-lab/`):

- **Run all scenarios** drives the real dialogs through `history.back()`, links, taps and focus, and checks the URL, which dialogs are open, whether the current entry is the page's or a dialog's, and where focus went. Every check must pass.
- **By hand** lists what only a person can check: the browser's own back button, which scripts cannot press and which the browser treats differently from `history.back()`. Check it on a phone as well.

```sh
bun run dev:mock   # then sign in and open /dev/dialog-lab (port 3000 unless -p is given)
```

When a bug is found here, add a scenario for it to `scenarios.ts` before fixing it.
