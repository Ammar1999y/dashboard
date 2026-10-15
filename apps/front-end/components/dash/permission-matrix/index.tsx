import type { PagePermission } from '@/types/permission';
import type { KeyboardEvent } from 'react';

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';

import { useFormContext } from 'react-hook-form';
import {
  MSG_PERM_SHORTCUTS,
  MSG_PERM_SUMMARY_SWITCH,
  PERMISSION_MATRIX_SHORTCUTS,
} from '@/constants/messages';
import { useGrants } from '@/lib/grants';

import { useWidthClass } from '@/hooks/use-width-class';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { ErrorMessage } from '@/components/form/error-message';

import { Grid } from './grid';
import { toLevels, toPagePermissions } from './matrix';
import styles from './permission-matrix.module.css';
import {
  createMatrixStore,
  MatrixStoreContext,
  useMatrix,
  useMatrixActions,
  useMatrixStoreApi,
} from './store';

const FIELD = 'permissions';

/**
 * Below this width the grid's minimum columns (922px together) would scroll
 * sideways, so each page becomes its own block instead.
 */
const STACK_BELOW = 940;

interface PermissionMatrixProps {
  /** Shown, never edited; the host form says why. */
  readOnly?: boolean;
}

/**
 * The form's `permissions` field, as a page × verb grid. It starts from the
 * field's value, empty when there is none, and writes every page back —
 * including on mount, so a new record submits the grid it shows. The field is
 * cleared on unmount: a user form that leaves the custom role must not submit
 * a matrix the schema then rejects.
 */
export const PermissionMatrix = memo(
  ({ readOnly = false }: PermissionMatrixProps) => {
    const { getValues, setValue } = useFormContext<{
      permissions?: PagePermission[];
    }>();
    const { permissions: grants } = useGrants();
    const [store] = useState(() =>
      createMatrixStore({
        levels: toLevels(getValues(FIELD) ?? []),
        grants,
        readOnly,
      })
    );

    useEffect(() => {
      store.getState().actions.setAccess(grants, readOnly);
    }, [store, grants, readOnly]);

    useEffect(() => {
      setValue(FIELD, toPagePermissions(store.getState().levels));
      const unsubscribe = store.subscribe(({ levels }, previous) => {
        if (levels !== previous.levels)
          setValue(FIELD, toPagePermissions(levels));
      });
      return () => {
        unsubscribe();
        store.getState().actions.dispose();
        setValue(FIELD, undefined);
      };
    }, [store, setValue]);

    return (
      <MatrixStoreContext.Provider value={store}>
        <MatrixView />
        <ErrorMessage name={FIELD} />
      </MatrixStoreContext.Provider>
    );
  }
);

PermissionMatrix.displayName = 'PermissionMatrix';

const isStacked = (width: number) => width < STACK_BELOW;

const isEditable = (target: EventTarget) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

function MatrixView() {
  const root = useRef<HTMLElement>(null);
  const stacked = useWidthClass(root, isStacked, false);
  const summary = useMatrix((s) => s.summary);
  const titleId = useId();
  const store = useMatrixStoreApi();
  const { showTabStop } = useMatrixActions();

  useEffect(() => {
    if (stacked) showTabStop();
  }, [stacked, showTabStop]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== '?' || isEditable(e.target)) return;
      e.preventDefault();
      const { help, actions } = store.getState();
      actions.setHelp(!help);
    },
    [store]
  );

  return (
    <section
      ref={root}
      aria-labelledby={titleId}
      className={styles.root}
      data-stacked={stacked}
      data-summary={summary ? 'on' : 'off'}
      onKeyDown={onKeyDown}
    >
      <div className='flex items-center gap-3'>
        <h2 id={titleId} className='me-auto text-lg font-semibold'>
          الصلاحيات
        </h2>
        <SummarySwitch />
        <Shortcuts />
      </div>
      <Grid />
    </section>
  );
}

const SummarySwitch = memo(() => {
  const id = useId();
  const summary = useMatrix((s) => s.summary);
  const { setSummary } = useMatrixActions();

  return (
    <div className='flex items-center gap-2'>
      <Switch id={id} checked={summary} onCheckedChange={setSummary} />
      <Label
        htmlFor={id}
        title={MSG_PERM_SUMMARY_SWITCH}
        className='mb-0 font-normal text-muted-foreground'
      />
    </div>
  );
});

SummarySwitch.displayName = 'PermissionMatrixSummarySwitch';

const Shortcuts = memo(() => {
  const open = useMatrix((s) => s.help);
  const { setHelp } = useMatrixActions();
  const close = useCallback(() => setHelp(false), [setHelp]);

  return (
    <Popover open={open} onOpenChange={setHelp}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          size='none'
          className='size-7 rounded-full text-sm text-muted-foreground'
          aria-label={MSG_PERM_SHORTCUTS}
        >
          ?
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-96 max-w-[calc(100vw-1rem)]'
        aria-label={MSG_PERM_SHORTCUTS}
      >
        <div className='mb-2 flex items-center justify-between'>
          <h3 className='text-sm font-semibold'>{MSG_PERM_SHORTCUTS}</h3>
          <Button
            type='button'
            variant='ghost'
            size='none'
            className='size-7'
            aria-label='إغلاق'
            onClick={close}
          >
            <Icon icon='solar:close-linear' className='size-4' />
          </Button>
        </div>
        <dl className='grid grid-cols-[auto_1fr] items-center gap-x-3.5 gap-y-1.5 text-xs'>
          {PERMISSION_MATRIX_SHORTCUTS.map(({ keys, text }) => (
            <div key={text} className='contents'>
              <dt className='flex flex-wrap gap-1'>
                {keys.map((key) => (
                  <Kbd key={key} keys={key} />
                ))}
              </dt>
              <dd className='text-muted-foreground'>{text}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
});

Shortcuts.displayName = 'PermissionMatrixShortcuts';
