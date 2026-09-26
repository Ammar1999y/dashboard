/**
 * The box every text-like control is drawn in — input, textarea, select
 * trigger, combobox — so they read as one family. Size, padding and layout
 * stay with each control; only the surface lives here. `text-base` below `md`
 * keeps iOS Safari from zooming into a focused field.
 */
export const fieldSurface =
  'rounded-md border bg-input text-base text-foreground transition duration-300 hover:shadow-md dark:bg-input/30 hover:dark:bg-input/45 md:text-sm';
