import type { FileWithPreview } from './file-types';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Creates object URLs for previews and revokes each once its file leaves
 * `files`, or on unmount. URLs it did not create (e.g. from `initialFiles`) are
 * never revoked.
 */
export function usePreviewUrls(files: readonly FileWithPreview[]) {
  const owned = useRef(new Set<string>());
  const previous = useRef(files);

  // Diffed against the previous list, not against `owned`: a URL created for a
  // file still being appended is in neither list yet and must survive.
  useEffect(() => {
    const live = new Set(files.map((file) => file.preview));
    for (const { preview } of previous.current) {
      if (preview && !live.has(preview) && owned.current.delete(preview))
        URL.revokeObjectURL(preview);
    }
    previous.current = files;
  }, [files]);

  useEffect(() => {
    const urls = owned.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  return useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    owned.current.add(url);
    return url;
  }, []);
}
