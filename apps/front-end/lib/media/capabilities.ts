import type { BucketType } from '@app/shared/validation/enums';

import { create } from 'zustand';

interface Capabilities {
  /** Whether the caller holds `media.publish`, as the server last said. */
  canPublish: boolean;
  /** The buckets this deployment has configured. */
  visibilities: readonly BucketType[];
}

/**
 * What the last listing said about this deployment and this caller. Rows and
 * dialogs read it where the listing's own props do not reach them.
 */
export const useCapabilities = create<Capabilities>(() => ({
  canPublish: false,
  visibilities: [],
}));
