import type {
  TurnstileInstance,
  TurnstileProps,
} from '@marsidev/react-turnstile';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Turnstile as _Turnstile } from '@marsidev/react-turnstile';
import { useTheme } from 'next-themes';
import { useFormContext, useFormState } from 'react-hook-form';
import { toast } from 'sonner';
import { MSG_BROWSER_UNSUPPORTED } from '@/constants/messages';
import { takeSentCaptcha } from '@/lib/auth/captcha';

import { useFormErrors } from '@/components/form/store';

const Turnstile = memo(_Turnstile);
Turnstile.displayName = 'Turnstile';

const SCRIPT_OPTIONS = { id: 'turnstile-script' };

const SITE_KEY =
  process.env.NODE_ENV === 'development'
    ? '1x00000000000000000000AA'
    : (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '');

/** Unloaded this long, the script is fetched again. */
const LOAD_RETRY_MS = 8000;
const RELOAD_DELAY_MS = 500;

const onUnsupported = () =>
  toast.error(MSG_BROWSER_UNSUPPORTED, { duration: 20_000 });

/**
 * What the widget needs of its form: a `captcha` field, which the form's schema
 * validates (`captchaField` in `@/utils/validation/auth`).
 */
type CaptchaFields = { captcha: string };

/**
 * A token is single-use: a submit that sent the one it carried spent it,
 * whatever its outcome, so the form needs a new one as soon as that submit
 * settles. A submit that stopped at validation sent nothing, and its token is
 * still good.
 */
function useOnTokenSpent(onSpent: () => void) {
  const { isSubmitting } = useFormState();
  const { getValues } = useFormContext<CaptchaFields>();
  const wasSubmitting = useRef(false);

  useEffect(() => {
    if (isSubmitting) {
      wasSubmitting.current = true;
      return;
    }
    if (!wasSubmitting.current) return;
    wasSubmitting.current = false;
    if (takeSentCaptcha(getValues('captcha'))) onSpent();
  }, [isSubmitting, getValues, onSpent]);
}

/** Writes its token into the surrounding form's `captcha` field. */
const TurnstileWidget = memo(() => {
  const { resolvedTheme } = useTheme();
  const options = useMemo<TurnstileProps['options']>(
    () => ({
      theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      language: 'ar',
      size: 'flexible',
    }),
    [resolvedTheme]
  );

  const errors = useFormErrors();
  const ref = useRef<TurnstileInstance>(null);
  // Flipping it remounts the widget with a freshly fetched script.
  const [reloading, setReloading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { setValue } = useFormContext<CaptchaFields>();

  useEffect(() => {
    if (!reloading && !errors.captcha) return;

    document.querySelector(`#${SCRIPT_OPTIONS.id}`)?.remove();
    const timeout = setTimeout(() => {
      ref.current?.render();
      ref.current?.execute();
      ref.current?.reset();
      setReloading(false);
    }, RELOAD_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [reloading, errors]);

  const renewToken = useCallback(() => {
    setValue('captcha', '');
    ref.current?.reset();
  }, [setValue]);
  useOnTokenSpent(renewToken);

  useEffect(() => {
    if (loaded) return;
    const interval = setInterval(() => setReloading(true), LOAD_RETRY_MS);
    return () => clearInterval(interval);
  }, [loaded]);

  const onSuccess = useCallback(
    (token: string) => setValue('captcha', token),
    [setValue]
  );
  const resetWidget = useCallback(() => ref.current?.reset(), []);
  const onError = useCallback(() => setReloading(true), []);
  const onWidgetLoad = useCallback(() => setLoaded(true), []);

  return (
    <Turnstile
      key={reloading ? 'reloading' : 'live'}
      ref={ref}
      siteKey={SITE_KEY}
      scriptOptions={SCRIPT_OPTIONS}
      options={options}
      onError={onError}
      onExpire={resetWidget}
      onTimeout={resetWidget}
      onSuccess={onSuccess}
      onUnsupported={onUnsupported}
      onWidgetLoad={onWidgetLoad}
    />
  );
});

TurnstileWidget.displayName = 'TurnstileWidget';

// A mock run must work offline, so no widget: a fresh token per submit, which
// the mocks refuse to see twice, as the verifier does.
const newMockToken = () => `mock-captcha-${crypto.randomUUID()}`;

// A plain function, not `memo(...)` with a `displayName`: those are side
// effects that keep it in the real bundle after the flag folds to false.
function MockCaptcha() {
  const { setValue } = useFormContext<CaptchaFields>();
  const setToken = useCallback(
    () => setValue('captcha', newMockToken()),
    [setValue]
  );

  useEffect(() => {
    setToken();
  }, [setToken]);
  useOnTokenSpent(setToken);

  return null;
}

export default process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
  ? MockCaptcha
  : TurnstileWidget;
