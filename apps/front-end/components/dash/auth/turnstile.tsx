import type { LoginInput } from '@/utils/validation/auth';
import type {
  TurnstileInstance,
  TurnstileProps,
} from '@marsidev/react-turnstile';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Turnstile as _Turnstile } from '@marsidev/react-turnstile';
import { useTheme } from 'next-themes';
import { useFormContext } from 'react-hook-form';
import { toast } from 'sonner';

import { useFormErrors } from '@/components/form/store';

const Turnstile = memo(_Turnstile);
Turnstile.displayName = 'Turnstile';

const SCRIPT_OPTIONS = { id: 'turnstile-script' };

// A mock build runs on localhost, where the real key is refused.
const SITE_KEY =
  process.env.NODE_ENV === 'development' ||
  process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
    ? '1x00000000000000000000AA'
    : (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '');

/** Unloaded this long, the script is fetched again. */
const LOAD_RETRY_MS = 8000;
const RELOAD_DELAY_MS = 500;

const onUnsupported = () =>
  toast.error(
    'المتصفح غير مدعوم، قم بتغير المتصفح او استخدام اخر نسخة للمتابعة.',
    { duration: 20_000 }
  );

interface TurnstileWidgetProps {
  /** Set by the form after a failed sign-in; the widget clears it once reset. */
  reset: boolean;
  setReset: (value: boolean) => void;
}

/** Writes its token into the form's `captcha` field. */
const TurnstileWidget = memo(({ reset, setReset }: TurnstileWidgetProps) => {
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
  const { setValue } = useFormContext<LoginInput>();

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

  // A token is single-use: every failed attempt needs a new one.
  useEffect(() => {
    if (!reset && Object.keys(errors).length === 0) return;
    ref.current?.reset();
    setReset(false);
  }, [reset, errors, setReset]);

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

export default TurnstileWidget;
