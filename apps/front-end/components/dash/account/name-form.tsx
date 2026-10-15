import type { UserDetail } from '@/types/user';
import type { RenameInput, RenameOutput } from '@/utils/validation/account';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { selfUpdateUserBodySchema } from '@app/shared/validation/auth';
import { renameSelf } from '@/lib/users/rename';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { userEntity } from '../users/entity';

/** The one field a user may change of their own record; no proof is asked for it. */
export const NameForm = memo(({ user }: { user: UserDetail }) => {
  const queryClient = useQueryClient();
  const { id } = user;
  const methods = useForm<RenameInput, unknown, RenameOutput>({
    resolver: zodResolver(selfUpdateUserBodySchema),
    defaultValues: { name: user.name },
  });
  const { reset } = methods;

  const onSubmit = useCallback(
    async ({ name }: RenameOutput) => {
      const result = await renameSelf(queryClient, userEntity, id, name);
      toast.success(result.message);
      reset({ name });
    },
    [id, queryClient, reset]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit} className='space-y-4'>
      <FormInput name='name' label='الاسم' autoComplete='name' required />
      <SubmitButton>
        <SubmitLabel pending='جاري الحفظ...'>حفظ</SubmitLabel>
      </SubmitButton>
    </Form>
  );
});

NameForm.displayName = 'NameForm';
