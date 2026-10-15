import type { CodeInput, CodeOutput } from '@/utils/validation/auth';

import { memo, useCallback, useMemo } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  MSG_ENROL_SIGNS_OUT_OTHERS,
  MSG_TOTP_ENTER_CODE,
  MSG_TOTP_SCAN,
  MSG_TOTP_SECRET,
} from '@/constants/messages';
import { confirmTotp, totpSecretOf } from '@/lib/account/two-factor';

import { codeFormSchema } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StoreDialog } from '@/components/dialogs/store-dialog';
import { Form } from '@/components/form/form';
import FormOtp from '@/components/form/form-otp';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';
import { QrCode } from '@/components/shared/qr-code';

import { CopyButton } from '../copy-button';
import { totpDialog } from '../dialogs';

const TotpBody = memo(({ totpURI }: { totpURI: string }) => {
  const queryClient = useQueryClient();
  const secret = useMemo(() => totpSecretOf(totpURI), [totpURI]);
  const methods = useForm<CodeInput, unknown, CodeOutput>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: '' },
  });

  const onSubmit = useCallback(
    async ({ code }: CodeOutput) => {
      const result = await confirmTotp(queryClient, code);
      if (result.message) toast.success(result.message);
      totpDialog.close();
    },
    [queryClient]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit} className='contents'>
      <div className='px-4 space-y-4'>
        <div className='flex justify-center'>
          <QrCode
            value={totpURI}
            label='رمز QR لإضافة الحساب إلى تطبيق المصادقة'
            className='size-48 rounded-md border'
          />
        </div>
        {secret && (
          <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3'>
            <div className='min-w-0'>
              <div className='text-xs text-muted-foreground'>
                {MSG_TOTP_SECRET}
              </div>
              <code dir='ltr' className='bidi-isolate break-all text-sm'>
                {secret}
              </code>
            </div>
            <CopyButton value={secret} label='نسخ المفتاح' />
          </div>
        )}
        <FormOtp name='code' label={MSG_TOTP_ENTER_CODE} autoFocus required />
        <p className='text-xs text-muted-foreground'>
          {MSG_ENROL_SIGNS_OUT_OTHERS}
        </p>
      </div>
      <div className='mt-auto flex flex-row justify-end gap-2 p-4'>
        <Button variant='ghost' onClick={totpDialog.close}>
          إلغاء
        </Button>
        <SubmitButton>
          <SubmitLabel pending='جاري التفعيل...'>تفعيل</SubmitLabel>
        </SubmitButton>
      </div>
    </Form>
  );
});

TotpBody.displayName = 'TotpBody';

/** Scan, then prove the app holds the secret: only the code turns the method on. */
const TotpDialog = memo(() => {
  const payload = totpDialog.usePayload();

  return (
    <StoreDialog dialog={totpDialog} className='sm:max-w-md'>
      <DialogHeader>
        <DialogTitle>إضافة تطبيق مصادقة</DialogTitle>
        <DialogDescription>{MSG_TOTP_SCAN}</DialogDescription>
      </DialogHeader>
      {payload && <TotpBody key={payload.totpURI} totpURI={payload.totpURI} />}
    </StoreDialog>
  );
});

TotpDialog.displayName = 'TotpDialog';

export default TotpDialog;
