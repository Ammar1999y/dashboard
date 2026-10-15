import type { FactorOption } from './options';
import type { CodeInput, CodeOutput } from '@/utils/validation/auth';

import { memo, useCallback } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { MSG_TWO_FACTOR_TRUST_DEVICE } from '@/constants/messages';

import { codeFormSchema } from '@/utils/validation/auth';

import { Form } from '@/components/form/form';
import FormInput from '@/components/form/form-input';
import FormOtp from '@/components/form/form-otp';
import SubmitButton, { SubmitLabel } from '@/components/form/submit-button';

import { CheckboxOption } from '../checkbox-option';
import { backupCodeSchema } from './options';

const backupSchema = z.object({ code: backupCodeSchema });

export interface TrustControl {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

interface CodePanelProps {
  option: FactorOption;
  onVerify: (option: FactorOption, code: string) => Promise<void>;
  /** Present only where the server lets a verified device be remembered. */
  trust?: TrustControl;
  submitLabel: string;
  pendingLabel: string;
}

/** The code of an authenticator app, a code that was sent, or a backup code. */
export const CodePanel = memo(
  ({ option, onVerify, trust, submitLabel, pendingLabel }: CodePanelProps) => {
    const isBackup = option.method === 'backup_code';
    const schema = isBackup ? backupSchema : codeFormSchema;

    const methods = useForm<CodeInput, unknown, CodeOutput>({
      resolver: zodResolver(schema),
      defaultValues: { code: '' },
    });

    const onSubmit = useCallback(
      ({ code }: CodeOutput) => onVerify(option, code),
      [onVerify, option]
    );

    return (
      <Form methods={methods} onSubmit={onSubmit} className='mt-6 space-y-6'>
        {isBackup ? (
          <FormInput
            name='code'
            label='الرمز الاحتياطي'
            dir='ltr'
            placeholder='xxxxx-xxxxx'
            autoFocus
            required
          />
        ) : (
          <FormOtp name='code' label='رمز التحقق' autoFocus required />
        )}

        {trust && (
          <CheckboxOption label={MSG_TWO_FACTOR_TRUST_DEVICE} {...trust} />
        )}

        <SubmitButton className='w-full'>
          <SubmitLabel pending={pendingLabel}>{submitLabel}</SubmitLabel>
        </SubmitButton>
      </Form>
    );
  }
);

CodePanel.displayName = 'CodePanel';
