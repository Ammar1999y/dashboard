import type { StoredPreferences } from '@app/shared/validation/preferences';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTheme } from 'next-themes';
import { getPreferences, updatePreferences } from '@app/shared/api/users';
import { DEFAULT_PREFERENCES } from '@app/shared/validation/preferences';
import { MSG_RETRY } from '@/constants/messages';
import { api } from '@/lib/api/client';
import { useSession } from '@/lib/auth/use-session';
import { toastError } from '@/lib/toast-error';

import { applyPreset } from './apply-preset';
import { useSettingStore, useThemeLayout } from './layout-store';
import { isColorMode, samePreferences } from './preferences';
import { createPreferencesSaver } from './preferences-saver';
import { useEditorStore } from './store';

const SAVE_DELAY_MS = 600;
const LOAD_TOAST = { id: 'preferences-load' };
const SAVE_TOAST = { id: 'preferences-save' };

/**
 * Writes `saved` over this device's choices. Each store is touched only where
 * it differs, so what the user is looking at does not re-render for nothing.
 */
function applyPreferences(
  saved: StoredPreferences,
  local: StoredPreferences,
  setTheme: (mode: StoredPreferences['colorMode']) => void
) {
  const editor = useEditorStore.getState();
  if (saved.preset !== local.preset) applyPreset(saved.preset);
  if (saved.fontScale !== local.fontScale) editor.setFontScale(saved.fontScale);
  if (saved.containerStretch !== local.containerStretch)
    editor.setContainerStretch(saved.containerStretch);
  if (saved.themeLayout !== local.themeLayout)
    useSettingStore.getState().actions.setThemeLayout(saved.themeLayout);
  if (saved.colorMode !== local.colorMode) setTheme(saved.colorMode);
}

/**
 * Keeps the signed-in user's appearance in step with their account. The
 * stores keep their own copy in `localStorage`, which paints the first frame
 * and serves a signed-out visitor; this loads the account's copy after
 * sign-in and applies it, then saves what the user changes.
 *
 * The account's copy wins on load, as the server's document is total: a
 * change made in the moment before the load answers is overwritten by it. An
 * account that never saved one keeps what this device holds, which is saved as
 * its first document unless it is the default. A load that failed is tried
 * again when the window next gains focus, or from the toast.
 */
export const PreferencesSync = memo(() => {
  const userId = useSession().data?.user.id;
  const { theme, setTheme } = useTheme();
  const preset = useEditorStore(
    (s) => s.themeState.preset ?? DEFAULT_PREFERENCES.preset
  );
  const fontScale = useEditorStore((s) => s.fontScale);
  const containerStretch = useEditorStore((s) => s.containerStretch);
  const themeLayout = useThemeLayout();
  const colorMode = isColorMode(theme) ? theme : DEFAULT_PREFERENCES.colorMode;

  const local = useMemo<StoredPreferences>(
    () => ({ preset, colorMode, themeLayout, fontScale, containerStretch }),
    [preset, colorMode, themeLayout, fontScale, containerStretch]
  );

  // `setTheme` changes identity with every theme change, which must not
  // reload the account's copy.
  const latest = useRef({ local, setTheme });
  useEffect(() => {
    latest.current = { local, setTheme };
  });

  /**
   * What the server holds or will hold once the save in progress lands: the
   * loaded document, then each one scheduled. `null` after a failed save,
   * when nothing can be assumed.
   */
  const target = useRef<StoredPreferences | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const retryLoad = useCallback(() => {
    setLoadFailed(false);
    setAttempt((count) => count + 1);
  }, []);

  const [saver] = useState(() =>
    createPreferencesSaver({
      delayMs: SAVE_DELAY_MS,
      send: (preferences, signal) =>
        api(updatePreferences, { body: preferences }, { signal }),
      onFailed: (error) => {
        target.current = null;
        toastError(error, undefined, SAVE_TOAST);
      },
    })
  );

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    api(getPreferences, undefined, { signal: controller.signal })
      .then(({ data }) => {
        const current = latest.current;
        // A save of this device's choices from before the account's copy was
        // here must not land over it.
        saver.cancel();
        if (data.updatedAt === null) {
          target.current = DEFAULT_PREFERENCES;
        } else {
          target.current = data.preferences;
          applyPreferences(data.preferences, current.local, current.setTheme);
        }
        setLoadedFor(userId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        toastError(error, undefined, {
          ...LOAD_TOAST,
          action: { label: MSG_RETRY, onClick: retryLoad },
        });
      });

    return () => {
      controller.abort();
      saver.cancel();
      target.current = null;
      // Ready only once the document of whoever is signed in next has loaded:
      // the same account signing back in is not ready on the strength of the
      // last session's load.
      setLoadedFor(null);
    };
  }, [userId, saver, attempt, retryLoad]);

  useEffect(() => {
    if (!loadFailed) return;
    window.addEventListener('focus', retryLoad);
    return () => window.removeEventListener('focus', retryLoad);
  }, [loadFailed, retryLoad]);

  const ready = !!userId && loadedFor === userId;

  useEffect(() => {
    if (!ready) return;
    const expected = target.current;
    if (expected && samePreferences(local, expected)) return;
    target.current = local;
    saver.schedule(local);
  }, [local, ready, saver]);

  return null;
});

PreferencesSync.displayName = 'PreferencesSync';
