import type { Entity } from './entity';
import type { EntityID } from '@/types';
import type { QueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';

import { memo, useCallback, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { mutate, toastError } from '@/utils/mutation';
import { cacheRemoved } from '@/utils/query-cache';

import { Button } from '@/components/ui/button';
import { actionsColumn } from '@/components/ui/data-table';
import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LabelTooltip } from '@/components/ui/tooltip';

type AfterDelete = (queryClient: QueryClient, id: EntityID) => void;

interface RowActionsProps {
  entity: Entity;
  id: EntityID;
  /** The row's own name, shown in the delete confirmation. */
  name: string;
  /** Other caches that hold the row. Module-level, so the memo holds. */
  afterDelete?: AfterDelete;
}

/**
 * The actions column of an entity's table: edit link and confirmed delete.
 * `getName` and `afterDelete` are module-level, like the columns themselves.
 */
export function rowActionsColumn<TRow extends { id: EntityID }>(
  entity: Entity,
  getName: (row: TRow) => string,
  afterDelete?: AfterDelete
): ColumnDef<TRow> {
  return actionsColumn<TRow>((row) => (
    <RowActions
      entity={entity}
      id={row.id}
      name={getName(row)}
      afterDelete={afterDelete}
    />
  ));
}

const RowActions = memo(({ entity, id, ...deleteProps }: RowActionsProps) => (
  <div className='flex items-center justify-end gap-1 text-muted-foreground'>
    <LabelTooltip label={`تعديل ${entity.noun}`}>
      <Link href={entity.editRoute(id)} variant='defaultGhost' size='icon'>
        <Icon icon='solar:pen-new-square-linear' className='size-4' />
      </Link>
    </LabelTooltip>
    <DeleteAction entity={entity} id={id} {...deleteProps} />
  </div>
));

RowActions.displayName = 'RowActions';

const DeleteAction = memo(
  ({ entity, id, name, afterDelete }: RowActionsProps) => {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleCancel = useCallback(() => setOpen(false), []);

    const handleConfirm = useCallback(async () => {
      setLoading(true);
      try {
        const result = await mutate({
          href: entity.itemHref(id),
          method: 'DELETE',
          // Only once the server has deleted it.
          onSuccess: () => {
            cacheRemoved(queryClient, entity.keys, id);
            afterDelete?.(queryClient, id);
          },
        });
        toast.success(result.message || `تم حذف ${entity.noun} بنجاح`);
        setOpen(false);
      } catch (error) {
        toastError(error);
      } finally {
        setLoading(false);
      }
    }, [entity, id, queryClient, afterDelete]);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <LabelTooltip label={`حذف ${entity.noun}`}>
          <PopoverTrigger asChild>
            <Button variant='destructiveGhost' size='icon'>
              <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
            </Button>
          </PopoverTrigger>
        </LabelTooltip>

        <PopoverContent className='w-80'>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <h4 className='font-medium leading-none'>تأكيد العملية</h4>
              <p className='text-sm text-muted-foreground'>
                سوف يتم حذف {entity.noun} <strong>{name}</strong>.
                <br />
                هذا الإجراء لا يمكن التراجع عنه.
              </p>
            </div>
            <div className='flex items-center gap-2'>
              <Button
                variant='ghost'
                className='flex-1'
                onClick={handleCancel}
                disabled={loading}
              >
                إلغاء
              </Button>
              <Button
                className='flex-1'
                onClick={handleConfirm}
                disabled={loading}
                variant='destructive'
              >
                {loading ? 'جاري الحذف...' : 'حذف'}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

DeleteAction.displayName = 'DeleteAction';
