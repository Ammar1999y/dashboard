import type { MediaContext } from './context';
import type { RefObject } from 'react';

import { useEffect } from 'react';

import { idOfKey, isFolderKey } from '@/lib/media/keys';
import { getSelection } from '@/lib/media/selection';
import { setUploadsOpen, useUploads } from '@/lib/media/upload-queue';

import { getClip } from './clip';
import { command, readCommandState, runCommand } from './commands';
import { closeMenu, useItemMenu } from './menu-store';
import {
  arrow,
  clearSelection,
  enterFolder,
  goUp,
  gridPerRow,
  historyGo,
  leaveResults,
  moveCursor,
  selectAll,
  typeAhead,
} from './navigation';
import { cancelCut } from './operations';
import { getBrowser, isResults } from './store';

const ALT_COMMANDS: Readonly<Record<string, string>> = {
  KeyN: 'newfolder',
  KeyU: 'upload',
  Digit1: 'view-columns',
  Digit2: 'view-grid',
  Digit3: 'view-list',
  KeyI: 'inspector',
};

const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.matches('input,textarea,select'));

/**
 * The library's keyboard, while focus is in it or on nothing at all: a
 * shortcut never fires from the dashboard's other controls, a dialog, or a
 * field.
 */
export function useKeyboard(
  ctx: MediaContext,
  root: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { target, key } = event;
      const inside =
        target === document.body ||
        (target instanceof Node && !!root.current?.contains(target));
      if (
        !inside ||
        event.defaultPrevented ||
        useItemMenu.getState().open ||
        isField(target)
      )
        return;
      const mod = event.ctrlKey || event.metaKey;
      const state = () => readCommandState(ctx);
      const run = (id: string) => runCommand(ctx, id, state());

      const interactive =
        target instanceof Element && target.closest('button,a,[role=tab]');
      if (
        interactive &&
        (key === 'Enter' || key === ' ' || key.startsWith('Arrow'))
      )
        return;

      if (mod) {
        if (event.code === 'KeyA') {
          event.preventDefault();
          selectAll(ctx.queryClient);
        } else if (event.code === 'KeyX' && getSelection().keys.size > 0) {
          event.preventDefault();
          run('cut');
        } else if (event.code === 'KeyV' && getClip()) {
          event.preventDefault();
          run('paste');
        } else if (key === '[') {
          event.preventDefault();
          historyGo(-1);
        } else if (key === ']') {
          event.preventDefault();
          historyGo(1);
        } else if (key === 'ArrowUp') {
          event.preventDefault();
          goUp();
        }
        return;
      }
      if (event.altKey) {
        const id = ALT_COMMANDS[event.code];
        if (!id) return;
        event.preventDefault();
        run(id);
        return;
      }

      switch (key) {
        case '/': {
          event.preventDefault();
          run('search');
          return;
        }
        case '?':
        case '؟': {
          event.preventDefault();
          run('shortcuts');
          return;
        }
        case 'Escape': {
          closeMenu();
          if (useUploads.getState().open) setUploadsOpen(false);
          else if (getSelection().keys.size > 0) clearSelection();
          else if (getClip()) cancelCut();
          else if (isResults(getBrowser())) leaveResults();
          return;
        }
        case 'F2': {
          event.preventDefault();
          run('rename');
          return;
        }
        case 'Delete': {
          if (getSelection().keys.size === 0) return;
          event.preventDefault();
          run('delete');
          return;
        }
        case 'Enter': {
          const { keys } = getSelection();
          const [first] = keys;
          if (!first) return;
          event.preventDefault();
          if (keys.size === 1 && isFolderKey(first))
            enterFolder(ctx.queryClient, idOfKey(first));
          else run('preview');
          return;
        }
        case ' ': {
          event.preventDefault();
          if (command('preview').enabled(state())) run('preview');
          return;
        }
        case 'Backspace': {
          event.preventDefault();
          goUp();
          return;
        }
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          if (event.shiftKey) {
            const step =
              getBrowser().view === 'grid' ? gridPerRow(root.current) : 1;
            moveCursor(
              ctx.queryClient,
              key === 'ArrowDown' ? step : -step,
              true
            );
          } else arrow(ctx.queryClient, key, root.current);
          return;
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          event.preventDefault();
          if (event.shiftKey && getBrowser().view === 'grid')
            moveCursor(ctx.queryClient, key === 'ArrowLeft' ? 1 : -1, true);
          else arrow(ctx.queryClient, key, root.current);
          return;
        }
        default: {
          if (key.length === 1 && !event.altKey)
            typeAhead(ctx.queryClient, key);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ctx, root]);
}
