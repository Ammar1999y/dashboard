import type { useMediaAccess } from './access';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { createContext, useContext } from 'react';

/**
 * What the library's operations need beyond its stores, which they read
 * through `getState()`: the query cache they write to and what the user may
 * do. One object per mount, so reading it never re-renders.
 */
export interface MediaContext {
  queryClient: QueryClient;
  access: ReturnType<typeof useMediaAccess>;
  /** The library's own area, which keyboard focus returns to. */
  focusBrowser: () => void;
  /**
   * Opens the system file picker; what is picked is uploaded into `target`
   * (`undefined`: the folder the user is in). `directory` picks a whole folder.
   */
  pickFiles: (options: {
    target?: EntityID | null;
    directory?: boolean;
  }) => void;
}

export const MediaContextValue = createContext<MediaContext | null>(null);

export function useMedia(): MediaContext {
  const value = useContext(MediaContextValue);
  if (!value) throw new Error('useMedia must be used inside the media library');
  return value;
}
