# Dialogs

Every dialog the app opens from code: the settings panel, the mobile menu, image zoom, the editor's media upload, and any new one. Each dialog has its own small store (`createDialog` in `lib/dialogs.ts`), and a dialog given a `urlId` also lives in the URL (`?module=`) and in the browser history, so the back button closes it.

Read this before changing anything here, or anything it depends on outside this folder: `lib/dialogs.ts`, `lib/history.ts`, the `beforePopState` callback in `pages/_app.tsx`, and `components/ui/data-table/filters/url-sync.tsx`, which writes the URL through the same helper. Nearly every rule below exists because breaking it once shipped a bug, listed next to it.

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

| Path                         | What it holds                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `lib/dialogs.ts`             | `createDialog`, the stack of open dialogs, everything that writes `?module=`     |
| `lib/history.ts`             | `writeUrl` (keeps Next's state), which page the current history entry belongs to |
| `store-dialog.tsx`           | binds a store to the Radix dialog; focus return                                  |
| `dialog-toggle.tsx`          | the trigger button for a dialog without data                                     |
| `dialog-close-button.tsx`    | the X button of the side sheets                                                  |
| `url-sync.tsx`               | popstate, route changes, restoring dialogs a URL names                           |
| `index.tsx`                  | the app-wide dialogs, mounted once from `_app`                                   |
| `image-zoom/`                | the image zoom dialog and its store                                              |
| `components/dev/dialog-lab/` | the lab at `/dev/dialog-lab`                                                     |

## How history works

One rule holds everything together: **every open dialog with a `urlId` owns exactly one history entry, stacked in the order they opened.** The URL lists the open ids in the same order.

| What happens                                        | What the code does                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| a dialog opens                                      | pushes one entry, a copy of Next's state flagged `__dialog`                                                                                         |
| it closes from the UI (X, Escape, outside click)    | `history.back()` removes the top entry; the popstate that fires is counted (`pendingBacks`) and only rewrites the entry below to what is still open |
| the browser back button, same page                  | `_app` tells Next to leave the pop alone (`shouldRoutePop`); `syncDialogsWithUrl` closes what the entry no longer lists                             |
| a link or `router.push` to another page             | Next pushes its entry; `routeChangeComplete` closes every dialog without touching history                                                           |
| back onto a dialog entry of a page left since       | skipped on the way to that page's own entry, so one press is enough                                                                                 |
| landing on, or navigating to, a URL with `?module=` | the params come off (Next's own `as` and `url` too), then each restorable dialog opens and pushes its entry                                         |

A page is identified by Next's `key` and `as` together (`lib/history.ts`). `key` alone is not enough: `router.replace` keeps it across pages.

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
