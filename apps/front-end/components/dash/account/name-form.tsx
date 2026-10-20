import type { UserDetail } from '@/types/user';
import type { RenameInput, RenameOutput } from '@/utils/validation/account';

import { useRouter } from 'next/router';
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

import { accountReturnPath } from '../auth/paths';
import { userEntity } from '../users/entity';

/**
 * The one field a user may change of their own record; no proof is asked for
 * it. Opened from another page, a rename returns there, as the administrator's
 * form returns to the list.
 */
export const NameForm = memo(({ user }: { user: UserDetail }) => {
  const queryClient = useQueryClient();
  const { query, push } = useRouter();
  const returnTo = accountReturnPath(query);
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
      if (returnTo) void push(returnTo);
    },
    [id, queryClient, reset, returnTo, push]
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
