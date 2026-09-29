import { popoverMotion, popoverSurface } from '@/components/ui/popover-surface';

/**
 * What the dropdown and context menus share — both are the Radix menu. Radix
 * focuses the item under the pointer, so `focus:` is the one highlight for
 * mouse and keyboard; a `hover:` one would light a second item while the arrow
 * keys move focus away from the pointer. The global focus ring is off because
 * the highlight already marks the item. Size limits and the transform origin
 * stay with each menu: their CSS variables are per-primitive.
 */
export const menuContent = `${popoverSurface} ${popoverMotion} min-w-32 overflow-x-hidden p-1 focus-visible:ring-0`;

export const menuSubContent = 'overflow-hidden shadow-lg';

export const menuItem =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground outline-none transition-all focus:bg-accent focus:text-accent-foreground focus-visible:ring-0 data-[disabled]:pointer-events-none data-[inset]:ps-8 data-[disabled]:opacity-50 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4";

export const menuSubTrigger =
  'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';
