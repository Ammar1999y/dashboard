'use client';

import type * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type {
  TElement,
  TTableCellElement,
  TTableElement,
  TTableRowElement,
} from 'platejs';
import type { PlateElementProps } from 'platejs/react';
import type { StoreApi } from 'zustand';

import * as React from 'react';

import { useDraggable, useDropLine } from '@platejs/dnd';
import {
  BlockSelectionPlugin,
  useBlockSelected,
} from '@platejs/selection/react';
import { setCellBackground } from '@platejs/table';
import {
  TablePlugin,
  TableProvider,
  useTableBordersDropdownMenuContentState,
  useTableCellElement,
  useTableCellElementResizable,
  useTableElement,
  useTableMergeState,
} from '@platejs/table/react';
import { PopoverAnchor } from '@radix-ui/react-popover';
import { KEYS, PathApi } from 'platejs';
import {
  PlateElement,
  useComposedRef,
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useElement,
  useElementSelector,
  useFocusedLast,
  usePluginOption,
  useReadOnly,
  useRemoveNodeButton,
  useSelected,
  withHOC,
} from 'platejs/react';
import { createStore, useStore } from 'zustand';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { Toolbar, ToolbarButton, ToolbarGroup } from '@/components/ui/toolbar';
import {
  TABLE_CELL_CONTENT_CLASS,
  TABLE_CLASS,
  tableCellClass,
  tableCellStyle,
  tableWrapperClass,
} from '@/components/editor/styles';

import { blockSelectionVariants } from './block-selection';
import { ColorMenuContent } from './color-menu';
import { ResizeHandle } from './resize-handle';
import {
  BorderAllIcon,
  BorderBottomIcon,
  BorderLeftIcon,
  BorderNoneIcon,
  BorderRightIcon,
  BorderTopIcon,
} from './table-icons';

/**
 * The column edge whose resize handle is hovered or dragged: a column index,
 * or the table's leading edge. Cells of that column draw the edge line, so the
 * line spans every row, which a per-cell `:hover` cannot do.
 */
const LEADING_EDGE = 'leading';
type ResizeEdge = number | typeof LEADING_EDGE | null;
type ResizeEdgeStore = StoreApi<{ edge: ResizeEdge }>;

const createResizeEdgeStore = (): ResizeEdgeStore =>
  createStore(() => ({ edge: null as ResizeEdge }));
const ResizeEdgeContext = React.createContext<ResizeEdgeStore>(
  createResizeEdgeStore()
);

const setResizeEdge = (
  store: ResizeEdgeStore,
  edge: Exclude<ResizeEdge, null>,
  active: boolean
) =>
  store.setState((s) =>
    active ? { edge } : s.edge === edge ? { edge: null } : s
  );

export const TableElement = withHOC(
  TableProvider,
  function TableElement({
    children,
    ...props
  }: PlateElementProps<TTableElement>) {
    const readOnly = useReadOnly();
    const isSelectionAreaVisible = usePluginOption(
      BlockSelectionPlugin,
      'isSelectionAreaVisible'
    );
    const element = useElement<TTableElement>();

    const hasControls = !readOnly && !isSelectionAreaVisible;
    const isSelectingCell = usePluginOption(TablePlugin, 'isSelectingCell');
    const { marginLeft, props: tableProps } = useTableElement();

    const isSelectingTable = useBlockSelected(props.element.id as string);
    const [resizeEdge] = React.useState(createResizeEdgeStore);

    const content = (
      <PlateElement
        {...props}
        className={cn(
          'py-5',
          hasControls &&
            'ltr:*:data-[slot=block-selection]:right-2 rtl:*:data-[slot=block-selection]:left-2',
          element.width !== 'full' && 'overflow-x-auto'
        )}
        style={{ paddingLeft: marginLeft }}
      >
        <div className={tableWrapperClass(element.width === 'full')}>
          <table
            className={cn(
              TABLE_CLASS,
              isSelectingCell && 'selection:bg-transparent',
              element.width === 'full' && 'w-full'
            )}
            {...tableProps}
          >
            <tbody className='min-w-full'>{children}</tbody>
          </table>

          {isSelectingTable && (
            <div className={blockSelectionVariants()} contentEditable={false} />
          )}
        </div>
      </PlateElement>
    );

    return (
      <ResizeEdgeContext.Provider value={resizeEdge}>
        {readOnly ? (
          content
        ) : (
          <TableFloatingToolbar>{content}</TableFloatingToolbar>
        )}
      </ResizeEdgeContext.Provider>
    );
  }
);

function TableFloatingToolbar({
  children,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const selected = useSelected();
  const element = useElement<TTableElement>();
  const { props: buttonProps } = useRemoveNodeButton({ element });
  const collapsedInside = useEditorSelector(
    (editor) => selected && editor.api.isCollapsed(),
    [selected]
  );
  const isFocusedLast = useFocusedLast();

  const { canMerge, canSplit } = useTableMergeState();

  return (
    <Popover
      modal={false}
      open={isFocusedLast && (canMerge || canSplit || collapsedInside)}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        asChild
        contentEditable={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        {...props}
      >
        <Toolbar
          className='flex w-auto max-w-[80vw] flex-row overflow-x-auto rounded-md border bg-popover p-1 shadow-md print:hidden'
          contentEditable={false}
        >
          <ToolbarGroup>
            {collapsedInside && (
              <ToolbarButton
                onClick={() => {
                  const newWidth = element.width === 'full' ? 'fit' : 'full';
                  editor.tf.setNodes({ width: newWidth }, { at: element });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip={element.width === 'full' ? 'عرض مخصص' : 'عرض كامل'}
              >
                {element.width === 'full' ? (
                  <Icon icon='solar:minimize-linear' />
                ) : (
                  <Icon icon='solar:maximize-linear' />
                )}
              </ToolbarButton>
            )}
            <ColorDropdownMenu tooltip='لون الخلفية'>
              <Icon icon='lucide:paint-bucket' />
            </ColorDropdownMenu>
            {canMerge && (
              <ToolbarButton
                onClick={() => tf.table.merge()}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='دمج الخلايا'
              >
                <Icon icon='lucide:combine' />
              </ToolbarButton>
            )}
            {canSplit && (
              <ToolbarButton
                onClick={() => tf.table.split()}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='تقسيم الخلية'
              >
                <Icon icon='solar:table-columns-split-linear' />
              </ToolbarButton>
            )}

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <ToolbarButton tooltip='حدود الخلية'>
                  <Icon icon='solar:grid-2x2-linear' />
                </ToolbarButton>
              </DropdownMenuTrigger>

              <DropdownMenuPortal>
                <TableBordersDropdownMenuContent />
              </DropdownMenuPortal>
            </DropdownMenu>

            {collapsedInside && (
              <ToolbarGroup>
                <ToolbarButton tooltip='حذف الجدول' {...buttonProps}>
                  <Icon icon='solar:trash-bin-trash-linear' />
                </ToolbarButton>
              </ToolbarGroup>
            )}
          </ToolbarGroup>

          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableRow({ before: true });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج صف قبل'
              >
                <Icon icon='lucide:between-vertical-end' />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableRow();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج صف بعد'
              >
                <Icon icon='lucide:between-vertical-start' />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.remove.tableRow();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='حذف الصف'
              >
                <Icon
                  icon='hugeicons:column-delete'
                  className='-rotate-90 scale-x-[-1]'
                />
              </ToolbarButton>
            </ToolbarGroup>
          )}

          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableColumn({ before: true });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج عمود قبل'
              >
                <Icon icon='lucide:between-horizontal-end' />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableColumn();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج عمود بعد'
              >
                <Icon icon='lucide:between-horizontal-start' />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.remove.tableColumn();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='حذف العمود'
              >
                <Icon icon='hugeicons:column-delete' />
              </ToolbarButton>
            </ToolbarGroup>
          )}
        </Toolbar>
      </PopoverContent>
    </Popover>
  );
}

function TableBordersDropdownMenuContent(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Content>
) {
  const editor = useEditorRef();
  const {
    getOnSelectTableBorder,
    hasBottomBorder,
    hasLeftBorder,
    hasNoBorders,
    hasOuterBorders,
    hasRightBorder,
    hasTopBorder,
  } = useTableBordersDropdownMenuContentState();

  return (
    <DropdownMenuContent
      align='start'
      className='min-w-56'
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        editor.tf.focus();
      }}
      side='right'
      sideOffset={0}
      {...props}
    >
      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          checked={hasTopBorder}
          onCheckedChange={getOnSelectTableBorder('top')}
        >
          <BorderTopIcon />
          <div>حد علوي</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasRightBorder}
          onCheckedChange={getOnSelectTableBorder('right')}
        >
          <BorderRightIcon />
          <div>حد أيمن</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasBottomBorder}
          onCheckedChange={getOnSelectTableBorder('bottom')}
        >
          <BorderBottomIcon />
          <div>حد سفلي</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasLeftBorder}
          onCheckedChange={getOnSelectTableBorder('left')}
        >
          <BorderLeftIcon />
          <div>حد أيسر</div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>

      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          checked={hasNoBorders}
          onCheckedChange={getOnSelectTableBorder('none')}
        >
          <BorderNoneIcon />
          <div>بلا حدود</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasOuterBorders}
          onCheckedChange={getOnSelectTableBorder('outer')}
        >
          <BorderAllIcon />
          <div>حدود خارجية</div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

function ColorDropdownMenu({
  children,
  tooltip,
}: {
  children: React.ReactNode;
  tooltip: string;
}) {
  const [open, setOpen] = React.useState(false);
  const editor = useEditorRef();
  const selectedCells = usePluginOption(TablePlugin, 'selectedCells');

  const setBackground = React.useCallback(
    (color: string | null) => {
      setOpen(false);
      setCellBackground(editor, { color, selectedCells: selectedCells ?? [] });
    },
    [selectedCells, editor]
  );
  const clearBackground = React.useCallback(
    () => setBackground(null),
    [setBackground]
  );

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton tooltip={tooltip}>{children}</ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start'>
        <ColorMenuContent onClear={clearBackground} onSelect={setBackground} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TableRowElement({
  children,
  ...props
}: PlateElementProps<TTableRowElement>) {
  const { element } = props;
  const readOnly = useReadOnly();
  const selected = useSelected();
  const editor = useEditorRef();
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    'isSelectionAreaVisible'
  );
  const hasControls = !readOnly && !isSelectionAreaVisible;

  const { isDragging, previewRef, handleRef } = useDraggable({
    element,
    type: element.type,
    canDropNode: ({ dragEntry, dropEntry }) =>
      !!dragEntry &&
      PathApi.equals(
        PathApi.parent(dragEntry[1]),
        PathApi.parent(dropEntry[1])
      ),
    onDropHandler: (_, { dragItem }) => {
      const dragElement = (dragItem as { element: TElement }).element;

      if (dragElement) {
        editor.tf.select(dragElement);
      }
    },
  });

  return (
    <PlateElement
      {...props}
      as='tr'
      attributes={{
        ...props.attributes,
        'data-selected': selected ? 'true' : undefined,
      }}
      className={cn('group/row', isDragging && 'opacity-50')}
      ref={useComposedRef(props.ref, previewRef)}
    >
      {hasControls && (
        <td className='w-0 select-none' contentEditable={false}>
          <RowDragHandle dragRef={handleRef} />
          <RowDropLine />
        </td>
      )}

      {children}
    </PlateElement>
  );
}

function RowDragHandle({ dragRef }: { dragRef: React.Ref<HTMLButtonElement> }) {
  const editor = useEditorRef();
  const element = useElement();

  return (
    <Button
      className={cn(
        'absolute top-1/2 z-[51] h-6 w-4 -translate-y-1/2 p-0 focus-visible:ring-0 focus-visible:ring-offset-0 ltr:right-0 rtl:left-0',
        'cursor-grab active:cursor-grabbing',
        'opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-data-[resizing=true]/row:opacity-0'
      )}
      onClick={() => {
        editor.tf.select(element);
      }}
      ref={dragRef}
      variant='outline'
    >
      <Icon
        icon='solar:grip-vertical-linear'
        className='text-muted-foreground'
      />
    </Button>
  );
}

function RowDropLine() {
  const { dropLine } = useDropLine();

  if (!dropLine) return null;

  return (
    <div
      className={cn(
        'absolute inset-x-0 z-50 h-0.5 bg-primary/50 ltr:right-2 rtl:left-2',
        dropLine === 'top' ? '-top-px' : '-bottom-px'
      )}
    />
  );
}

export function TableCellElement({
  isHeader,
  ...props
}: PlateElementProps<TTableCellElement> & {
  isHeader?: boolean;
}) {
  const { api } = useEditorPlugin(TablePlugin);
  const readOnly = useReadOnly();
  const element = props.element;

  const tableId = useElementSelector(([node]) => node.id as string, [], {
    key: KEYS.table,
  });
  const rowId = useElementSelector(([node]) => node.id as string, [], {
    key: KEYS.tr,
  });
  const isSelectingTable = useBlockSelected(tableId);
  const isSelectingRow = useBlockSelected(rowId) || isSelectingTable;
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    'isSelectionAreaVisible'
  );

  const { borders, colIndex, colSpan, minHeight, rowIndex, selected, width } =
    useTableCellElement();

  const { bottomProps, hiddenLeft, leftProps, rightProps } =
    useTableCellElementResizable({
      colIndex,
      colSpan,
      rowIndex,
    });

  const resizeEdge = React.useContext(ResizeEdgeContext);
  const showColumnEdge = useStore(resizeEdge, (s) => s.edge === colIndex);
  const showLeadingEdge = useStore(
    resizeEdge,
    (s) => colIndex === 0 && s.edge === LEADING_EDGE
  );
  const handleColumnEdge = React.useCallback(
    (active: boolean) => setResizeEdge(resizeEdge, colIndex, active),
    [resizeEdge, colIndex]
  );
  const handleLeadingEdge = React.useCallback(
    (active: boolean) => setResizeEdge(resizeEdge, LEADING_EDGE, active),
    [resizeEdge]
  );

  return (
    <PlateElement
      {...props}
      as={isHeader ? 'th' : 'td'}
      attributes={{
        ...props.attributes,
        colSpan: api.table.getColSpan(element),
        rowSpan: api.table.getRowSpan(element),
      }}
      className={cn(
        tableCellClass({
          background: element.background,
          borders,
          isHeader: !!isHeader,
        }),
        selected && 'before:z-10 before:bg-primary/5'
      )}
      style={tableCellStyle(element, width)}
    >
      <div className={TABLE_CELL_CONTENT_CLASS} style={{ minHeight }}>
        {props.children}
      </div>

      {!isSelectionAreaVisible && (
        <div
          className='group absolute top-0 size-full select-none'
          contentEditable={false}
          suppressContentEditableWarning={true}
        >
          {!readOnly && (
            <>
              <ResizeHandle
                {...rightProps}
                className='-top-2 h-[calc(100%_+_8px)] w-2 ltr:-left-1 rtl:-right-1'
                onActiveChange={handleColumnEdge}
              />
              <ResizeHandle {...bottomProps} className='-bottom-1 h-2' />
              {!hiddenLeft && (
                <ResizeHandle
                  {...leftProps}
                  className='top-0 w-2 ltr:-right-1 rtl:-left-1'
                  onActiveChange={
                    colIndex === 0 ? handleLeadingEdge : undefined
                  }
                />
              )}

              {showColumnEdge && (
                <div className='absolute top-0 z-30 h-full w-1 bg-ring animate-in fade-in ltr:left-[-1.5px] rtl:right-[-1.5px]' />
              )}
              {showLeadingEdge && (
                <div className='absolute top-0 z-30 h-full w-1 bg-ring animate-in fade-in ltr:right-[-1.5px] rtl:left-[-1.5px]' />
              )}
            </>
          )}
        </div>
      )}

      {isSelectingRow && (
        <div className={blockSelectionVariants()} contentEditable={false} />
      )}
    </PlateElement>
  );
}

export function TableCellHeaderElement(
  props: React.ComponentProps<typeof TableCellElement>
) {
  return <TableCellElement {...props} isHeader />;
}
