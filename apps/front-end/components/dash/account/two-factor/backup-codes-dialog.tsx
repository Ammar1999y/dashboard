import { memo, useCallback, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MSG_BACKUP_CODES_ACKNOWLEDGE,
  MSG_BACKUP_CODES_LEAVE,
  MSG_BACKUP_CODES_ONCE,
  MSG_BACKUP_CODES_UNACKNOWLEDGED,
  MSG_ENROL_SIGNS_OUT_OTHERS,
} from '@/constants/messages';
import { acknowledgeBackupCodes } from '@/lib/account/two-factor';
import { downloadBlob } from '@/lib/files/download';

import { useAsyncAction } from '@/hooks/use-async-action';
import { useLeaveGuard } from '@/hooks/use-leave-guard';
import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';
import { CheckboxOption } from '@/components/dash/auth/checkbox-option';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { CopyButton } from '../copy-button';
import { backupCodesDialog } from '../dialogs';

const FILE_NAME = 'backup-codes.txt';

interface BackupCodesBodyProps {
  codes: readonly string[];
  setId: string;
}

const BackupCodesBody = memo(({ codes, setId }: BackupCodesBodyProps) => {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);

  const text = codes.join('\n');
  const handleDownload = useCallback(
    () => downloadBlob(new Blob([text], { type: 'text/plain' }), FILE_NAME),
    [text]
  );

  const acknowledge = useCallback(async () => {
    const result = await acknowledgeBackupCodes(queryClient, setId);
    if (result.message) toast.success(result.message);
    backupCodesDialog.close();
  }, [queryClient, setId]);
  const { pending, run: handleAcknowledge } = useAsyncAction(acknowledge);

  return (
    <>
      <div className='px-4 space-y-4'>
        <ul
          dir='ltr'
          className='grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm'
        >
          {codes.map((code) => (
            <li key={code} className='text-center'>
              {code}
            </li>
          ))}
        </ul>
        <div className='flex flex-wrap items-center gap-2'>
          <CopyButton value={text} label='نسخ الرموز' />
          <Button variant='outline' size='sm' onClick={handleDownload}>
            <Icon
              icon='solar:download-minimalistic-linear'
              className='size-4'
            />
            تنزيل
          </Button>
        </div>
        <Notice>{MSG_BACKUP_CODES_ONCE}</Notice>
        <CheckboxOption
          label={MSG_BACKUP_CODES_ACKNOWLEDGE}
          checked={saved}
          onCheckedChange={setSaved}
        />
        <p className='text-xs text-muted-foreground'>
          {MSG_ENROL_SIGNS_OUT_OTHERS}
        </p>
      </div>
      <div className='mt-auto flex flex-row justify-end gap-2 p-4'>
        <Button
          variant='ghost'
          onClick={backupCodesDialog.close}
          disabled={pending}
        >
          إغلاق دون تأكيد
        </Button>
        <Button onClick={handleAcknowledge} disabled={!saved || pending}>
          {pending ? 'جاري التفعيل...' : 'تأكيد الحفظ'}
        </Button>
      </div>
    </>
  );
});

BackupCodesBody.displayName = 'BackupCodesBody';

const keepOpen = (event: Event) => event.preventDefault();

/**
 * The codes are shown once and cannot be shown again, so a stray click or
 * Escape must not close the dialog. A route change closes every dialog, which
 * is what the leave guard answers; only the dialog's own buttons end it.
 */
const BackupCodesDialog = memo(() => {
  const payload = backupCodesDialog.usePayload();
  const isOpen = backupCodesDialog.useIsOpen();
  useLeaveGuard(isOpen, MSG_BACKUP_CODES_LEAVE);

  return (
    <StoreDialog
      dialog={backupCodesDialog}
      className='sm:max-w-md'
      onEscapeKeyDown={keepOpen}
      onInteractOutside={keepOpen}
    >
      <DialogHeader>
        <DialogTitle>الرموز الاحتياطية</DialogTitle>
        <DialogDescription>{MSG_BACKUP_CODES_UNACKNOWLEDGED}</DialogDescription>
      </DialogHeader>
      {payload && (
        <BackupCodesBody
          key={payload.setId}
          codes={payload.codes}
          setId={payload.setId}
        />
      )}
    </StoreDialog>
  );
});

BackupCodesDialog.displayName = 'BackupCodesDialog';

export default BackupCodesDialog;
