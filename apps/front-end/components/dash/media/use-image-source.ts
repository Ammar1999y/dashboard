import type { LibraryFile } from '@/lib/media/schemas';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchLibraryFile } from '@/lib/media/queries';

import { useMedia } from './context';

/** `signing`: a link is being asked for, and no image is shown until it comes. */
type Status = 'signing' | 'loading' | 'loaded' | 'failed';

interface Source {
  /** The listing's link this state is for; a new one starts over. */
  for: string;
  src: string;
  status: Status;
  /** A link signed just now was tried already: a second failure is final. */
  resigned: boolean;
  /**
   * Bumped by every new try. Links signed in one window are identical, so the
   * element is remounted to load the same one again.
   */
  attempt: number;
}

const fresh = (url: string): Source => ({
  for: url,
  src: url,
  status: 'loading',
  resigned: false,
  attempt: 0,
});

/**
 * The full image of `file`, with its loading state. A private file's link is
 * signed and expires, so a link that fails is asked for again once, signed
 * now; failing after that is reported, with `retry` to ask once more.
 */
export function useImageSource(file: Pick<LibraryFile, 'id' | 'url'>) {
  const { queryClient } = useMedia();
  const [source, setSource] = useState(() => fresh(file.url));
  if (source.for !== file.url) setSource(fresh(file.url));

  const latest = useRef(file.url);
  useEffect(() => {
    latest.current = file.url;
  }, [file.url]);

  const resign = useCallback(async () => {
    const asked = file.url;
    setSource((current) => ({ ...current, status: 'signing', resigned: true }));
    try {
      const detail = await fetchLibraryFile(queryClient, file.id, {
        fresh: true,
      });
      if (latest.current !== asked) return;
      setSource((current) => ({
        ...current,
        src: detail.url,
        status: 'loading',
        attempt: current.attempt + 1,
      }));
    } catch {
      if (latest.current !== asked) return;
      setSource((current) => ({ ...current, status: 'failed' }));
    }
  }, [queryClient, file.id, file.url]);

  const onLoad = useCallback(
    () => setSource((current) => ({ ...current, status: 'loaded' })),
    []
  );
  const onError = useCallback(() => {
    if (source.resigned)
      setSource((current) => ({ ...current, status: 'failed' }));
    else void resign();
  }, [source.resigned, resign]);
  const retry = useCallback(() => void resign(), [resign]);

  return {
    src: source.src,
    attempt: source.attempt,
    status: source.status,
    /** Whether the element should be in the page: not while a link is asked for, nor once it failed. */
    shown: source.status === 'loading' || source.status === 'loaded',
    onLoad,
    onError,
    retry,
  };
}
