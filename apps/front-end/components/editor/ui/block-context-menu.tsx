'use client';

import type { Alignment } from '@platejs/basic-styles';

import * as React from 'react';

import {
  BLOCK_CONTEXT_MENU_ID,
  BlockMenuPlugin,
  BlockSelectionPlugin,
} from '@platejs/selection/react';
import { useEditorPlugin, usePlateState, usePluginOption } from 'platejs/react';

import { useIsTouchDevice } from '@/hooks/use-is-touch-device';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Icon } from '@/components/ui/icon';
import { ALIGN_ITEMS } from '@/components/editor/align';
import { BLOCK_MENU_TURN_INTO_ITEMS } from '@/components/editor/block-types';
import { setBlockType } from '@/components/editor/transforms';

export function BlockContextMenu({ children }: { children: React.ReactNode }) {
  const { api, editor } = useEditorPlugin(BlockMenuPlugin);
  const isTouch = useIsTouchDevice();
  const [readOnly] = usePlateState('readOnly');
  const openId = usePluginOption(BlockMenuPlugin, 'openId');
  const isOpen = openId === BLOCK_CONTEXT_MENU_ID;

  const selection = React.useCallback(
    () => editor.getTransforms(BlockSelectionPlugin).blockSelection,
    [editor]
  );

  const handleTurnInto = React.useCallback(
    (type: string) => {
      for (const [, path] of editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes()) {
        setBlockType(editor, type, { at: path });
      }
    },
    [editor]
  );

  const handleAlign = React.useCallback(
    (align: Alignment) => selection().setNodes({ align }),
    [selection]
  );

  if (isTouch) return children;

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) api.blockMenu.hide();
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          const { dataset } = event.target as HTMLElement;
          if (
            readOnly ||
            dataset.slateEditor === 'true' ||
            dataset.plateOpenContextMenu === 'false'
          ) {
            event.preventDefault();
            return;
          }

          setTimeout(() => {
            api.blockMenu.show(BLOCK_CONTEXT_MENU_ID, {
              x: event.clientX,
              y: event.clientY,
            });
          }, 0);
        }}
      >
        <div className='w-full [&>div]:!ring-0'>{children}</div>
      </ContextMenuTrigger>
      {isOpen && (
        <ContextMenuContent
          className='w-52'
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor.getApi(BlockSelectionPlugin).blockSelection.focus();
          }}
        >
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() => {
                selection().removeNodes();
                editor.tf.focus();
              }}
            >
              <Icon icon='solar:trash-bin-trash-linear' />
              حذف
            </ContextMenuItem>
            <ContextMenuItem onClick={() => selection().duplicate()}>
              <Icon icon='solar:copy-linear' />
              تكرار
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Icon icon='lucide:refresh-ccw' />
                تحويل إلى
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className='w-40'>
                {BLOCK_MENU_TURN_INTO_ITEMS.map((item) => (
                  <ContextMenuItem
                    key={item.value}
                    onClick={() => handleTurnInto(item.value)}
                  >
                    <Icon icon={item.icon} className={item.iconClassName} />
                    {item.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>

          <ContextMenuGroup>
            <ContextMenuItem onClick={() => selection().setIndent(1)}>
              <Icon
                icon='lucide:list-indent-increase'
                className='rtl:rotate-180'
              />
              زيادة المسافة
            </ContextMenuItem>
            <ContextMenuItem onClick={() => selection().setIndent(-1)}>
              <Icon
                icon='lucide:list-indent-decrease'
                className='rtl:rotate-180'
              />
              تقليل المسافة
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Icon icon='lucide:text-align-justify' />
                محاذاة
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className='w-40'>
                {ALIGN_ITEMS.map((item) => (
                  <ContextMenuItem
                    key={item.value}
                    onClick={() => handleAlign(item.value)}
                  >
                    <Icon icon={item.icon} />
                    {item.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
