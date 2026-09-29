import { useEffect } from 'react';

export const REMOVE_ITEM_SHORTCUTS = new Set(['backspace', 'delete']);

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.contentEditable === 'true')
  );
}

/** Toggles a popover on Ctrl/Cmd+Shift+`key`, ignored while the user is typing. */
export function usePopoverShortcut(key: string, toggle: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;

      if (
        event.key.toLowerCase() === key &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        toggle();
      }
    }

    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, [key, toggle]);
}
