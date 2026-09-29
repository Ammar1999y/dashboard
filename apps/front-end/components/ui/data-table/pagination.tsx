import { memo, useCallback, useMemo } from 'react';

import { cn, getPageNumbers } from '@/lib/utils';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

const goTo = (page: number) =>
  useDataTableStore.getState().actions.setPage(page);

const PageButton = memo(
  ({ page, isCurrent }: { page: number; isCurrent: boolean }) => {
    const handleClick = useCallback(() => goTo(page), [page]);
    return (
      <Button
        size='icon'
        variant={isCurrent ? 'none' : 'ghost'}
        className={cn(
          'h-8 w-8',
          isCurrent && 'border border-primary/70 bg-primary/30 font-medium'
        )}
        onClick={handleClick}
        aria-current={isCurrent ? 'page' : undefined}
      >
        {page}
      </Button>
    );
  }
);

PageButton.displayName = 'PageButton';

const handlePageSizeChange = (value: string) =>
  useDataTableStore.getState().actions.setPerPage(Number(value));

const DataTablePagination = memo(({ pageCount }: { pageCount: number }) => {
  const currentPage = useDataTableStore((s) => s.page);
  const perPage = useDataTableStore((s) => s.perPage);
  const totalPages = Math.max(1, pageCount);

  const pageNumbers = useMemo(
    () => getPageNumbers(currentPage, totalPages),
    [currentPage, totalPages]
  );

  const handlePrev = useCallback(() => goTo(currentPage - 1), [currentPage]);
  const handleNext = useCallback(() => goTo(currentPage + 1), [currentPage]);

  return (
    <div className='flex items-center justify-between px-2 py-1 space-x-3'>
      <div className='flex items-center space-x-2'>
        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          onClick={handlePrev}
          disabled={currentPage <= 1}
          aria-label='الصفحة السابقة'
        >
          <Icon icon='solar:alt-arrow-right-linear' className='size-4' />
        </Button>

        {pageNumbers.map((pageNumber, i) =>
          pageNumber === '...' ? (
            <span
              key={`ellipsis-${i}`}
              className='px-1 text-sm text-muted-foreground'
            >
              ...
            </span>
          ) : (
            <PageButton
              key={pageNumber}
              page={pageNumber}
              isCurrent={currentPage === pageNumber}
            />
          )
        )}

        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          onClick={handleNext}
          disabled={currentPage >= totalPages}
          aria-label='الصفحة التالية'
        >
          <Icon icon='solar:alt-arrow-left-linear' className='size-4' />
        </Button>
      </div>

      <Select value={perPage.toString()} onValueChange={handlePageSizeChange}>
        <SelectTrigger className='w-32 border-border'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PAGE_SIZE_OPTIONS.map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option} / صفحة
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
});

DataTablePagination.displayName = 'DataTablePagination';

export { DataTablePagination };
