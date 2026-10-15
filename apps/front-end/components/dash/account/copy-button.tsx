import { memo, useCallback, useEffect, useState } from 'react';

import { MSG_COPIED, MSG_COPY_FAILED } from '@/constants/messages';
import { toastError } from '@/lib/toast-error';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

const COPIED_MS = 2000;

interface CopyButtonProps {
  value: string;
  label: string;
}

export const CopyButton = memo(({ value, label }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch (error) {
      toastError(error, MSG_COPY_FAILED);
    }
  }, [value]);

  return (
    <Button variant='outline' size='sm' onClick={handleClick}>
      <Icon
        icon={copied ? 'solar:check-read-linear' : 'solar:copy-linear'}
        className='size-4'
      />
      {copied ? MSG_COPIED : label}
    </Button>
  );
});

CopyButton.displayName = 'CopyButton';
