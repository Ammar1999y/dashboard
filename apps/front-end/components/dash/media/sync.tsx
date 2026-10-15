import { memo, useEffect, useMemo } from 'react';

import { mirrorPageParams } from '@/lib/history';
import { folderKey } from '@/lib/media/keys';
import { getSelection, setSelection } from '@/lib/media/selection';

import { lastColumn, selectOnly } from './navigation';
import { currentFolder, getBrowser, isResults, useBrowser } from './store';
import { folderSource, listingKeys, useListing } from './use-listing';

/** The query parameter a link to a folder of the library carries. */
export const FOLDER_PARAM = 'folder';

/**
 * Keeps the path whole: a folder opened from a link or a search is known first
 * by its id alone, and its listing then names every folder above it.
 */
export const PathSync = memo(() => {
  const folder = useBrowser((s) => currentFolder(s.path));
  const source = useMemo(() => folderSource(folder), [folder]);
  const { listing } = useListing(source, { enabled: false });
  const crumbs = listing?.breadcrumbs;

  useEffect(() => {
    if (!crumbs || folder === null) return;
    const { path, history, historyIndex } = getBrowser();
    if (currentFolder(path) !== folder) return;
    const chain = [null, ...crumbs.map(({ id }) => id)];
    const whole =
      path.length === chain.length &&
      chain.every((id, index) => id === path[index]);
    if (whole) return;
    useBrowser.setState({
      path: chain,
      history: history.map((step, index) =>
        index === historyIndex ? chain : step
      ),
    });
    // The folder, selected where it was first placed, moves to its own column.
    const selection = getSelection();
    const key = folderKey(folder);
    if (
      selection.cursor.key === key &&
      typeof selection.cursor.col === 'number'
    )
      setSelection({
        ...selection,
        cursor: { key, col: chain.length - 2 },
      });
  }, [crumbs, folder]);

  return null;
});

PathSync.displayName = 'PathSync';

/**
 * Mirrors the folder the user is in to the address, without a navigation or a
 * history entry, so a reload or a shared link opens it again.
 */
export const UrlSync = memo(() => {
  useEffect(
    () =>
      mirrorPageParams({
        write: (params) => {
          const folder = currentFolder(getBrowser().path);
          if (folder) params.set(FOLDER_PARAM, folder);
          else params.delete(FOLDER_PARAM);
        },
        subscribe: useBrowser.subscribe,
        delayMs: 0,
      }),
    []
  );
  return null;
});

UrlSync.displayName = 'UrlSync';

/** Selects an item shown from the results once its folder is listed. */
export const RevealSync = memo(() => {
  const reveal = useBrowser((s) => s.reveal);
  const folder = useBrowser((s) => currentFolder(s.path));
  const source = useMemo(() => folderSource(folder), [folder]);
  const { listing, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useListing(source, { enabled: false });

  useEffect(() => {
    if (!reveal || !listing || isResults(getBrowser())) return;
    if (listingKeys(listing).includes(reveal)) {
      useBrowser.setState({ reveal: null });
      if (!getSelection().keys.has(reveal)) selectOnly(reveal, lastColumn());
      return;
    }
    // Further down the folder: its pages load until it shows, or end without it.
    if (isFetchingNextPage) return;
    if (hasNextPage) fetchNextPage();
    else useBrowser.setState({ reveal: null });
  }, [reveal, listing, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return null;
});

RevealSync.displayName = 'RevealSync';
