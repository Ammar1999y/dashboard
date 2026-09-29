import type { PointerEvent } from 'react';

/**
 * For controls inside a draggable column header: the header's drag listener
 * sits on its root, so a press on a button would otherwise start a drag.
 */
export const stopDragStart = (e: PointerEvent) => e.stopPropagation();
