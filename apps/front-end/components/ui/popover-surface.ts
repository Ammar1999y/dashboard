/**
 * The panel every floating layer is drawn in — popover, hover card, menus,
 * select and combobox content — and the enter/exit motion they share. The
 * transform origin stays with each control: its CSS variable is per-primitive.
 */
export const popoverSurface =
  'z-50 rounded-md border bg-popover text-popover-foreground shadow-md';

export const popoverMotion =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2';
