// Inside a `filterSegments` element (with `data-segmented`) the controls drop
// their own box and the group draws one outline around them; elsewhere, as in
// the column-header popover, they keep it. A control takes its radius from its
// parent, so whoever places it on a corner rounds that corner on the parent and
// the inset focus ring follows the group's curve.
const segment =
  'group-data-[segmented]/segments:rounded-[inherit] group-data-[segmented]/segments:border-0 group-data-[segmented]/segments:bg-transparent group-data-[segmented]/segments:shadow-none group-data-[segmented]/segments:ring-inset group-data-[segmented]/segments:hover:bg-accent/50';

export const filterSegments =
  'group/segments overflow-hidden rounded shadow-xs ring-1 ring-border dark:bg-input/30';

/** For controls drawn on `fieldSurface` (input, select trigger). */
export const filterField = `!h-8 w-full rounded bg-transparent shadow-xs hover:shadow-sm ${segment}`;

/** For a plain `Button` styled as a field. */
export const filterTrigger = `h-8 min-w-0 rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45 ${segment}`;

/** For a wrapper between a slot and its controls, so they can inherit its radius. */
export const filterSegmentWrapper =
  'group-data-[segmented]/segments:rounded-[inherit]';

/** The first of two controls sharing one slot: never on the slot's end corners. */
export const filterSegmentFirst =
  'group-data-[segmented]/segments:rounded-none';

/** The second of two controls sharing one slot, divided from the first. */
export const filterSegmentLast = 'group-data-[segmented]/segments:border-s';
