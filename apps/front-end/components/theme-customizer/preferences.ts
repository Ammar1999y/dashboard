import type { StoredPreferences } from '@app/shared/validation/preferences';

import { COLOR_MODES } from '@app/shared/validation/preferences';

export const PREFERENCES_HREF = '/api/dash/users/me/preferences';

export const isColorMode = (
  value: unknown
): value is StoredPreferences['colorMode'] =>
  (COLOR_MODES as readonly unknown[]).includes(value);

export const samePreferences = (a: StoredPreferences, b: StoredPreferences) =>
  a.preset === b.preset &&
  a.colorMode === b.colorMode &&
  a.themeLayout === b.themeLayout &&
  a.fontScale === b.fontScale &&
  a.containerStretch === b.containerStretch;
