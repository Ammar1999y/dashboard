import type { Entity } from './entity';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { noDataSchema } from '@app/shared/responses/common';
import { MSG_CONFIRM_DELETE } from '@/constants/messages';
import { mutate } from '@/lib/api/mutation';
import { cacheRemoved } from '@/lib/api/query-cache';

import { Button } from '@/components/ui/button';
import { actionsColumn } from '@/components/ui/data-table';
import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';
import { LabelTooltip } from '@/components/ui/tooltip';

import { useResourceAccess } from './access';
import { ConfirmAction } from './confirm-action';

type AfterDelete = (queryClient: QueryClient, id: EntityID) => void;

interface RowActionsProps {
  entity: Entity;
  id: EntityID;
  /** The row's own name, shown in the delete confirmation. */
  name: string;
  /** Other caches that hold the row. Module-level, so the memo holds. */
  afterDelete?: AfterDelete;
}

interface RowActionsOptions {
  /**
   * The rows are user accounts. The signed-in user's own row is editable
   * without the edit grant, and never deletable: the server refuses both.
   * Its edit link goes to this page, where an account is edited by its owner.
   */
  ownAccountHref?: string;
  /**
   * The rows are roles. The signed-in user's own role opens read only and is
   * never deletable: the server refuses an edit, and a delete while the role
   * has users, which it always has.
   */
  ownRole?: boolean;
}

/**
 * The actions column of an entity's table: edit link and confirmed delete,
 * each shown to a user who holds the grant. `getName` and `afterDelete` are
 * module-level, like the columns themselves.
 */
export function rowActionsColumn<TRow extends { id: EntityID }>(
  entity: Entity,
  getName: (row: TRow) => string,
  afterDelete?: AfterDelete,
  { ownAccountHref, ownRole }: RowActionsOptions = {}
): ColumnDef<TRow> {
  return actionsColumn<TRow>((row) => (
    <RowActions
      entity={entity}
      id={row.id}
      name={getName(row)}
      afterDelete={afterDelete}
      ownAccountHref={ownAccountHref}
      ownRole={ownRole}
    />
  ));
}

const RowActions = memo(
  ({
    entity,
    id,
    ownAccountHref,
    ownRole = false,
    ...deleteProps
  }: RowActionsProps & RowActionsOptions) => {
    const { userId, roleId, can } = useResourceAccess(entity.resource);
    const isOwnAccount = ownAccountHref !== undefined && id === userId;
    const isOwnRole = ownRole && id === roleId;
    const canEdit = can('edit') || isOwnAccount;
    const canDelete = can('delete') && !isOwnAccount && !isOwnRole;
    if (!canEdit && !canDelete) return null;

    return (
      <div className='flex items-center justify-end gap-1 text-muted-foreground'>
        {canEdit && (
          <LabelTooltip label={`${isOwnRole ? 'عرض' : 'تعديل'} ${entity.noun}`}>
            <Link
              href={isOwnAccount ? ownAccountHref : entity.editRoute(id)}
              variant='defaultGhost'
              size='icon'
            >
              <Icon
                icon={
                  isOwnRole ? 'solar:eye-linear' : 'solar:pen-new-square-linear'
                }
                className='size-4'
              />
            </Link>
          </LabelTooltip>
        )}
        {canDelete && <DeleteAction entity={entity} id={id} {...deleteProps} />}
      </div>
    );
  }
);

RowActions.displayName = 'RowActions';

const DeleteAction = memo(
  ({ entity, id, name, afterDelete }: RowActionsProps) => {
    const queryClient = useQueryClient();

    const remove = useCallback(() => {
      // `afterDelete` may read the row, so it runs before the row leaves.
      const write = () => {
        afterDelete?.(queryClient, id);
        cacheRemoved(queryClient, entity.keys, id);
      };
      return mutate({
        href: entity.itemHref(id),
        method: 'DELETE',
        schema: noDataSchema,
        onSuccess: write,
        onUnreadAnswer: write,
      });
    }, [entity, id, queryClient, afterDelete]);

    return (
      <ConfirmAction
        trigger={
          <Button variant='destructiveGhost' size='icon'>
            <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
          </Button>
        }
        triggerLabel={`حذف ${entity.noun}`}
        message={MSG_CONFIRM_DELETE(entity.noun, name)}
        confirmLabel='حذف'
        pendingLabel='جاري الحذف...'
        run={remove}
      />
    );
  }
);

DeleteAction.displayName = 'DeleteAction';
