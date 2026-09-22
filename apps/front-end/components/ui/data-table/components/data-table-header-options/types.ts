import { type Column } from '@tanstack/react-table';

export interface HeaderOptionsProps {
  column: Column<unknown, unknown>;
  className?: string;
}

export interface ColumnOptionsProps {
  column: Column<unknown, unknown>;
}

export interface OrderContext {
  order: string[];
  setOrder: (newOrder: string[]) => void;
}

export interface ColumnPosition {
  isFirst: boolean;
  isLast: boolean;
}
