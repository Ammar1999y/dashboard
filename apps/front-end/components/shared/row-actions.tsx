import { memo, useCallback, useState } from 'react';

import { EditIcon as _EditIcon, Trash2Icon as _Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { mutate, toastError } from '@/utils/mutation';

import { Button } from '@/components/ui/button';
import { Link } from '@/components/ui/link';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const EditIcon = memo(_EditIcon);
EditIcon.displayName = 'EditIcon';

const Trash2Icon = memo(_Trash2Icon);
Trash2Icon.displayName = 'Trash2Icon';

interface RowActionsProps {
  editHref: string;
  deleteHref: string;
  /** The entity in words, with its article: "المشروع". */
  noun: string;
  /** The row's own name, shown in the delete confirmation. */
  name: string;
  /** Removes the row from the cache; runs only once the server has deleted it. */
  onDeleted: () => void;
}

/** A table row's edit link and confirmed delete. */
const RowActions = memo(
  ({ editHref, deleteHref, noun, name, onDeleted }: RowActionsProps) => (
    <div className='flex items-center justify-end gap-1 text-muted-foreground'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={editHref}
            variant='defaultGhost'
            size='icon'
            aria-label={`تعديل ${noun}`}
          >
            <EditIcon className='h-4 w-4' />
          </Link>
        </TooltipTrigger>
        <TooltipContent>
          <p className='text-sm'>تعديل {noun}</p>
        </TooltipContent>
      </Tooltip>
      <DeleteAction
        href={deleteHref}
        noun={noun}
        name={name}
        onDeleted={onDeleted}
      />
    </div>
  )
);

RowActions.displayName = 'RowActions';

type DeleteActionProps = Omit<RowActionsProps, 'editHref' | 'deleteHref'> & {
  href: string;
};

const DeleteAction = memo(
  ({ href, noun, name, onDeleted }: DeleteActionProps) => {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleCancel = useCallback(() => setOpen(false), []);

    const handleConfirm = useCallback(async () => {
      setLoading(true);
      try {
        const result = await mutate({
          href,
          method: 'DELETE',
          onSuccess: onDeleted,
        });
        toast.success(result.message || `تم حذف ${noun} بنجاح`);
        setOpen(false);
      } catch (error) {
        toastError(error);
      } finally {
        setLoading(false);
      }
    }, [href, noun, onDeleted]);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant='destructiveGhost'
                size='icon'
                aria-label={`حذف ${noun}`}
              >
                <Trash2Icon className='h-4 w-4' />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>حذف {noun}</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent className='w-80'>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <h4 className='font-medium leading-none'>تأكيد العملية</h4>
              <p className='text-sm text-muted-foreground'>
                سوف يتم حذف {noun} <strong>{name}</strong>.
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

export { RowActions };
