import { memo } from 'react';

import { cn } from '@/lib/utils';

const isMac = () =>
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(`${navigator.platform} ${navigator.userAgent}`);

/** `Mod+X` as this keyboard writes it: `⌘X` on a Mac, `Ctrl+X` elsewhere. */
export const formatKeys = (keys: string) =>
  keys.replace('Mod+', () => (isMac() ? '⌘' : 'Ctrl+'));

/** A key or chord, always left to right, whatever the text around it. */
export const Kbd = memo(
  ({ keys, className }: { keys: string; className?: string }) => (
    <kbd
      dir='ltr'
      className={cn(
        'bidi-isolate inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground',
        className
      )}
    >
      {formatKeys(keys)}
    </kbd>
  )
);

Kbd.displayName = 'Kbd';
