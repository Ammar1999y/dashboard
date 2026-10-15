import type { EntityID } from '@app/shared/types';
import type { ChangeEvent, CSSProperties, KeyboardEvent } from 'react';

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import { FOLDER_NAME_MAX } from '@app/shared/validation/constants';
import { folderNameSchema } from '@app/shared/validation/media';
import {
  MSG_LIBRARY_ROOT,
  MSG_NO_SUBFOLDERS,
  MSG_PICK_FOLDER_FIRST,
  MSG_RETRY,
  MSG_UPLOAD_PICK_FOLDER,
} from '@/constants/messages';
import { createFolder } from '@/lib/media/actions';
import { useFolderChoices } from '@/lib/media/queries';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { useMedia } from './context';
import { folderPickerDialog } from './dialogs';
import { FolderGlyph } from './thumb';

interface Picker {
  expanded: ReadonlySet<EntityID | null>;
  selected: { id: EntityID; name: string } | null;
  /** The folder a new one is being named in. */
  creating: EntityID | null | undefined;
  toggle: (id: EntityID | null) => void;
  choose: (id: EntityID, name: string) => void;
  created: (parent: EntityID | null, id: EntityID, name: string) => void;
  stopCreating: () => void;
}

const PickerContext = createContext<Picker | null>(null);

function usePicker() {
  const picker = useContext(PickerContext);
  if (!picker)
    throw new Error('usePicker must be used inside the folder picker');
  return picker;
}

const indent = (depth: number) =>
  ({ paddingInlineStart: `${6 + depth * 18}px` }) as CSSProperties;

const SKELETON_WIDTHS = ['40%', '55%', '32%'].map((width) => ({ width }));

const NewFolderField = memo(
  ({ parent, depth }: { parent: EntityID | null; depth: number }) => {
    const { queryClient, access } = useMedia();
    const picker = usePicker();
    const [value, setValue] = useState('مجلد جديد');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const style = useMemo(() => indent(depth + 1), [depth]);
    const onChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
      []
    );
    const onKeyDown = useCallback(
      async (event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          picker.stopCreating();
          return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const parsed = folderNameSchema.safeParse(value);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? '');
          return;
        }
        setBusy(true);
        try {
          const { data } = await createFolder(queryClient, {
            parentId: parent,
            name: parsed.data,
            createdBy: access.userId,
            createdByName: access.displayName,
          });
          picker.created(parent, data.id, data.name);
        } catch (failure) {
          setError(errorMessage(failure));
          setBusy(false);
        }
      },
      [access.displayName, access.userId, parent, picker, queryClient, value]
    );
    return (
      <li>
        <div
          className='flex h-7 items-center gap-1.5 rounded-md px-1.5'
          style={style}
        >
          <span className='size-4 shrink-0' />
          <FolderGlyph className='size-[18px]' />
          <input
            autoFocus
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            disabled={busy}
            maxLength={FOLDER_NAME_MAX}
            aria-label='اسم المجلد الجديد'
            className='h-[22px] min-w-0 flex-1 rounded border bg-background px-1.5 outline-none'
          />
        </div>
        {error && <p className='px-2 text-xs text-destructive'>{error}</p>}
      </li>
    );
  }
);

NewFolderField.displayName = 'NewFolderField';

const Children = memo(
  ({ folder, depth }: { folder: EntityID | null; depth: number }) => {
    const picker = usePicker();
    const { page, error, refetch } = useFolderChoices(folder);
    const style = useMemo(() => indent(depth + 1), [depth]);
    const retry = useCallback(() => void refetch(), [refetch]);
    const context = page?.context;
    if (error && context?.scope !== 'folder')
      return (
        <li
          className='flex items-center gap-1.5 py-1 text-xs text-destructive'
          style={style}
        >
          <Icon icon='lucide:triangle-alert' className='size-3.5 shrink-0' />
          <span className='min-w-0 truncate'>{errorMessage(error)}</span>
          <button
            type='button'
            onClick={retry}
            className='shrink-0 text-primary hover:underline'
          >
            {MSG_RETRY}
          </button>
        </li>
      );
    if (context?.scope !== 'folder')
      return (
        <>
          {SKELETON_WIDTHS.map((width) => (
            <li key={width.width} className='py-1.5' style={style}>
              <span
                className='block h-2.5 animate-pulse rounded bg-muted'
                style={width}
              />
            </li>
          ))}
        </>
      );
    return (
      <>
        {picker.creating === folder && (
          <NewFolderField parent={folder} depth={depth} />
        )}
        {context.folders.map((child) => (
          <Node
            key={child.id}
            id={child.id}
            name={child.name}
            depth={depth + 1}
          />
        ))}
        {context.folders.length === 0 && picker.creating !== folder && (
          <li className='py-1 text-xs text-muted-foreground/70' style={style}>
            {MSG_NO_SUBFOLDERS}
          </li>
        )}
      </>
    );
  }
);

Children.displayName = 'Children';

const Node = memo(
  ({
    id,
    name,
    depth,
  }: {
    id: EntityID | null;
    name: string;
    depth: number;
  }) => {
    const picker = usePicker();
    const open = picker.expanded.has(id);
    const selected = id !== null && picker.selected?.id === id;
    const style = useMemo(() => indent(depth), [depth]);
    const toggle = useCallback(() => picker.toggle(id), [picker, id]);
    const choose = useCallback(() => {
      if (id !== null) picker.choose(id, name);
    }, [picker, id, name]);
    return (
      <li role='treeitem' aria-expanded={open} aria-selected={selected}>
        <div
          style={style}
          onClick={choose}
          onDoubleClick={toggle}
          className={cn(
            'flex h-7 cursor-default items-center gap-1.5 rounded-md border border-transparent pe-1.5 hover:bg-foreground/5',
            selected && 'border-primary/35 bg-primary/15 hover:bg-primary/15',
            id === null && 'opacity-60'
          )}
        >
          <button
            type='button'
            tabIndex={-1}
            onClick={toggle}
            aria-label={open ? 'طيّ' : 'توسيع'}
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded text-muted-foreground/70 transition-transform focus-visible:!ring-0',
              open && '-rotate-90 ltr:rotate-90'
            )}
          >
            <Icon
              icon='lucide:chevron-left'
              className='size-3.5 ltr:rotate-180'
            />
          </button>
          {id === null ? (
            <Icon icon='lucide:house' className='size-4 shrink-0' />
          ) : (
            <FolderGlyph className='size-[18px]' />
          )}
          <span className='min-w-0 flex-1 truncate' dir='auto'>
            {name}
          </span>
        </div>
        {open && (
          <ul role='group' className='m-0 list-none p-0'>
            <Children folder={id} depth={depth} />
          </ul>
        )}
      </li>
    );
  }
);

Node.displayName = 'Node';

const PickerBody = memo(
  ({ onPick }: { onPick: (id: EntityID, name: string) => void }) => {
    const [expanded, setExpanded] = useState<ReadonlySet<EntityID | null>>(
      () => new Set([null])
    );
    const [selected, setSelected] = useState<Picker['selected']>(null);
    const [creating, setCreating] = useState<EntityID | null | undefined>();
    const [error, setError] = useState('');

    const picker = useMemo<Picker>(
      () => ({
        expanded,
        selected,
        creating,
        toggle: (id) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
        choose: (id, name) => {
          setError('');
          setSelected({ id, name });
        },
        created: (_parent, id, name) => {
          setCreating(undefined);
          setSelected({ id, name });
        },
        stopCreating: () => setCreating(undefined),
      }),
      [expanded, selected, creating]
    );

    const startCreating = useCallback(() => {
      if (!selected) {
        setError(MSG_PICK_FOLDER_FIRST);
        return;
      }
      setError('');
      setCreating(selected.id);
      setExpanded((current) => new Set([...current, selected.id]));
    }, [selected]);

    const confirm = useCallback(() => {
      if (!selected) return;
      folderPickerDialog.close();
      onPick(selected.id, selected.name);
    }, [selected, onPick]);

    return (
      <PickerContext.Provider value={picker}>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Icon icon='lucide:folder-open' className='size-4' />
            اختر مجلد الرفع
          </DialogTitle>
        </DialogHeader>
        <div className='min-h-0 overflow-y-auto px-4 space-y-2'>
          <p className='flex items-start gap-2 rounded-md border bg-muted px-2.5 py-2 text-xs text-muted-foreground'>
            <Icon icon='lucide:info' className='mt-0.5 size-4 shrink-0' />
            {MSG_UPLOAD_PICK_FOLDER}
          </p>
          <ul
            role='tree'
            className='m-0 h-[300px] list-none overflow-auto rounded-lg border bg-background p-1'
          >
            <Node id={null} name={`${MSG_LIBRARY_ROOT} (الجذر)`} depth={0} />
          </ul>
          <p role='alert' className='min-h-4 text-xs text-destructive'>
            {error}
          </p>
        </div>
        <DialogFooter className='flex-row items-center'>
          <Button variant='outline' onClick={startCreating}>
            <Icon icon='lucide:folder-plus' className='size-4' />
            مجلد جديد
          </Button>
          <span className='flex-1' />
          <Button variant='ghost' onClick={folderPickerDialog.close}>
            إلغاء
          </Button>
          <Button onClick={confirm} disabled={!selected}>
            رفع إلى هذا المجلد
          </Button>
        </DialogFooter>
      </PickerContext.Provider>
    );
  }
);

PickerBody.displayName = 'PickerBody';

export const FolderPickerDialog = memo(() => {
  const request = folderPickerDialog.usePayload();
  return (
    <StoreDialog dialog={folderPickerDialog} className='sm:max-w-[580px]'>
      {request && <PickerBody onPick={request.onPick} />}
    </StoreDialog>
  );
});

FolderPickerDialog.displayName = 'FolderPickerDialog';
