import type { TrustControl } from './code-panel';

import { memo } from 'react';

import { MSG_TWO_FACTOR_TRUST_DEVICE } from '@/constants/messages';

import { useAsyncAction } from '@/hooks/use-async-action';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { CheckboxOption } from '../checkbox-option';

interface PasskeyPanelProps {
  onVerify: () => Promise<void>;
  trust?: TrustControl;
}

/** Options, the browser's ceremony, then the assertion: all behind one press. */
export const PasskeyPanel = memo(({ onVerify, trust }: PasskeyPanelProps) => {
  const { pending, run } = useAsyncAction(onVerify);

  return (
    <div className='mt-6 space-y-6'>
      {trust && (
        <CheckboxOption label={MSG_TWO_FACTOR_TRUST_DEVICE} {...trust} />
      )}
      <Button onClick={run} disabled={pending} className='w-full'>
        <Icon icon='solar:key-square-2-bold-duotone' className='size-5' />
        {pending ? 'بانتظار مفتاح المرور...' : 'التحقق بمفتاح المرور'}
      </Button>
    </div>
  );
});

PasskeyPanel.displayName = 'PasskeyPanel';
