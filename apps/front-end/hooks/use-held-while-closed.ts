import { useState } from 'react';

/**
 * `value` while `open`, and once closed the value it had when last rendered
 * open. A dialog or menu stays on screen while it animates out; content that
 * the action just changed (a deleted row, a cleared selection) would otherwise
 * redraw it, half empty, for the length of the exit.
 */
export function useHeldWhileClosed<T>(value: T, open: boolean): T {
  const [held, setHeld] = useState(value);
  if (open && held !== value) setHeld(value);
  return open ? value : held;
}
