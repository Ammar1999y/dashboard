import { useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { googleStart } from '@app/shared/api/better-auth';
import { HONOUR_REMEMBER_ME } from '@app/shared/config';
import { MSG_BACK_TO_SIGN_IN } from '@/constants/messages';
import { api } from '@/lib/api/client';

import { captchaField } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Form } from '@/components/form/form';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { OAUTH_COMPLETE_PATH } from './paths';
import TurnstileWidget from './turnstile';

const startSchema = z.object(captchaField);

type StartInput = z.input<typeof startSchema>;
type StartOutput = z.output<typeof startSchema>;

interface GoogleStartProps {
  rememberMe: boolean;
  onBack: () => void;
}

/**
 * Hands the browser to Google. The server wants a captcha token before it
 * issues the address, which is why this is a step of its own and not a button.
 */
export default function GoogleStart({ rememberMe, onBack }: GoogleStartProps) {
  const methods = useForm<StartInput, unknown, StartOutput>({
    resolver: zodResolver(startSchema),
    defaultValues: { captcha: '' },
  });

  const onSubmit = useCallback(
    async ({ captcha }: StartOutput) => {
      const { data } = await api(
        googleStart,
        {
          body: {
            mode: 'sign_in',
            callbackURL: OAUTH_COMPLETE_PATH,
            ...(HONOUR_REMEMBER_ME && { rememberMe }),
          },
        },
        { captcha }
      );
      location.assign(data.url);
    },
    [rememberMe]
  );

  return (
    <Form methods={methods} onSubmit={onSubmit} className='mt-6 space-y-6'>
      <TurnstileWidget />

      <SubmitButton className='w-full'>
        <Icon icon='uim:google' className='size-5' />
        <SubmitLabel pending='جاري التحويل إلى Google...'>
          المتابعة إلى Google
        </SubmitLabel>
      </SubmitButton>

      <Button variant='ghost' onClick={onBack} className='w-full'>
        {MSG_BACK_TO_SIGN_IN}
      </Button>
    </Form>
  );
}
