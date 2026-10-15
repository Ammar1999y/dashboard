import type {
  PasskeyNameInput,
  PasskeyNameOutput,
} from '@/utils/validation/account';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  MSG_ENROL_SIGNS_OUT_OTHERS,
  MSG_PASSKEY_ADDED,
  MSG_PASSKEY_ENROL_PROMPT,
  MSG_PASSKEY_NAME_HINT,
} from '@/constants/messages';
import { addPasskey } from '@/lib/account/two-factor';

import { passkeyNameFormSchema } from '@/utils/validation/account';

import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StoreDialog } from '@/components/dialogs/store-dialog';
import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { passkeyDialog } from '../dialogs';

const PasskeyForm = memo(() => {
  const queryClient = useQueryClient();
  const methods = useForm<PasskeyNameInput, unknown, PasskeyNameOutput>({
    resolver: zodResolver(passkeyNameFormSchema),
    defaultValues: { name: '' },
  });

  const onSubmit = useCallback(
    async ({ name }: PasskeyNameOutput) => {
      await addPasskey(queryClient, name || undefined);
      toast.success(MSG_PASSKEY_ADDED);
      passkeyDialog.close();
    },
    [queryClient]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit} className='contents'>
      <div className='px-4 space-y-4'>
        <FormInput
          name='name'
          label='اسم المفتاح'
          tip={MSG_PASSKEY_NAME_HINT}
          autoFocus
        />
        <p className='text-xs text-muted-foreground'>
          {MSG_ENROL_SIGNS_OUT_OTHERS}
        </p>
      </div>
      <div className='mt-auto flex flex-row justify-end gap-2 p-4'>
        <Button variant='ghost' onClick={passkeyDialog.close}>
          إلغاء
        </Button>
        <SubmitButton>
          <SubmitLabel pending='بانتظار مفتاح المرور...'>متابعة</SubmitLabel>
        </SubmitButton>
      </div>
    </Form>
  );
});

PasskeyForm.displayName = 'PasskeyForm';

const PasskeyDialog = memo(() => (
  <StoreDialog dialog={passkeyDialog} className='sm:max-w-md'>
    <DialogHeader>
      <DialogTitle>إضافة مفتاح مرور</DialogTitle>
      <DialogDescription>{MSG_PASSKEY_ENROL_PROMPT}</DialogDescription>
    </DialogHeader>
    <PasskeyForm />
  </StoreDialog>
));

PasskeyDialog.displayName = 'PasskeyDialog';

export default PasskeyDialog;
