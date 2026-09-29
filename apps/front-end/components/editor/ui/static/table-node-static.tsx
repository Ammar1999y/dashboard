import type { TTableCellElement, TTableElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { BaseTablePlugin } from '@platejs/table';
import { SlateElement } from 'platejs/static';
import { cn } from '@/lib/utils';

import {
  TABLE_CELL_CONTENT_CLASS,
  TABLE_CLASS,
  tableCellClass,
  tableCellStyle,
  tableWrapperClass,
} from '@/components/editor/styles';

export function TableElementStatic({
  children,
  ...props
}: SlateElementProps<TTableElement>) {
  const { disableMarginLeft } = props.editor.getOptions(BaseTablePlugin);
  const full = props.element.width === 'full';

  return (
    <SlateElement
      {...props}
      className={cn('py-5', !full && 'overflow-x-auto')}
      style={{
        paddingLeft: disableMarginLeft ? 0 : props.element.marginLeft,
      }}
    >
      <div className={tableWrapperClass(full)}>
        <table className={cn(TABLE_CLASS, full && 'w-full')}>
          <tbody className='min-w-full'>{children}</tbody>
        </table>
      </div>
    </SlateElement>
  );
}

export function TableRowElementStatic(props: SlateElementProps) {
  return <SlateElement {...props} as='tr' className='h-full' />;
}

function TableCellStatic({
  isHeader,
  ...props
}: SlateElementProps<TTableCellElement> & { isHeader: boolean }) {
  const { editor, element } = props;
  const { api } = editor.getPlugin(BaseTablePlugin);
  const { minHeight, width } = api.table.getCellSize({ element });

  return (
    <SlateElement
      {...props}
      as={isHeader ? 'th' : 'td'}
      attributes={{
        ...props.attributes,
        colSpan: api.table.getColSpan(element),
        rowSpan: api.table.getRowSpan(element),
      }}
      className={tableCellClass({
        background: element.background,
        borders: api.table.getCellBorders({ element }),
        isHeader,
      })}
      style={tableCellStyle(element, width)}
    >
      <div className={TABLE_CELL_CONTENT_CLASS} style={{ minHeight }}>
        {props.children}
      </div>
    </SlateElement>
  );
}

export function TableCellElementStatic(
  props: SlateElementProps<TTableCellElement>
) {
  return <TableCellStatic {...props} isHeader={false} />;
}

export function TableCellHeaderElementStatic(
  props: SlateElementProps<TTableCellElement>
) {
  return <TableCellStatic {...props} isHeader />;
}
