import type {
  CodeCaptchaInput,
  CodeCaptchaOutput,
} from '@/utils/validation/auth';
import type { ReactNode } from 'react';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { MSG_CODE_SENT_TO } from '@/constants/messages';
import { cn } from '@/lib/utils';

import { codeCaptchaFormSchema } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import { Form } from '@/components/form/form';
import FormOtp from '@/components/form/form-otp';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import TurnstileWidget from './turnstile';

interface CodeFormProps {
  /** Said above the field when the form is not under a prompt that names where the code went. */
  destination?: string;
  /** Takes the code with the captcha token the route verifies. */
  onVerify: (code: string, captcha: string) => Promise<void>;
  submitLabel: string;
  pendingLabel: string;
  /** The way back to where a code is asked for, to send one anew. */
  secondaryLabel: string;
  onSecondary: () => void;
  /** A choice that rides along with the code, such as remember me. */
  children?: ReactNode;
  /** The sign-in card's layout: full-width buttons, one under the other. */
  stacked?: boolean;
}

/**
 * The code that proves a contact is the user's, with the captcha its route
 * verifies. The token is single-use, so a new code is always a trip back
 * through `onSecondary`.
 */
export const CodeForm = memo(
  ({
    destination,
    onVerify,
    submitLabel,
    pendingLabel,
    secondaryLabel,
    onSecondary,
    children,
    stacked = false,
  }: CodeFormProps) => {
    const methods = useForm<CodeCaptchaInput, unknown, CodeCaptchaOutput>({
      resolver: zodResolver(codeCaptchaFormSchema),
      defaultValues: { code: '', captcha: '' },
    });

    const onSubmit = useCallback(
      ({ code, captcha }: CodeCaptchaOutput) => onVerify(code, captcha),
      [onVerify]
    );

    return (
      <Form
        methods={methods}
        onSubmit={onSubmit}
        className={stacked ? 'mt-6 space-y-6' : 'space-y-4'}
      >
        {destination && (
          <p className='text-sm text-muted-foreground'>
            {MSG_CODE_SENT_TO} <bdi dir='ltr'>{destination}</bdi>
          </p>
        )}
        <FormOtp name='code' label='رمز التحقق' autoFocus required />
        {children}
        <TurnstileWidget />
        <div className={stacked ? 'space-y-6' : 'flex items-center gap-2'}>
          <SubmitButton className={cn(stacked && 'w-full')}>
            <SubmitLabel pending={pendingLabel}>{submitLabel}</SubmitLabel>
          </SubmitButton>
          <Button
            variant='ghost'
            onClick={onSecondary}
            className={cn(stacked && 'w-full')}
          >
            {secondaryLabel}
          </Button>
        </div>
      </Form>
    );
  }
);

CodeForm.displayName = 'CodeForm';
