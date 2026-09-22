import { memo, useEffect, useState } from 'react';

import { Toaster as SonnerToaster } from 'sonner';

import { CheckmarkIcon } from '@/components/icons/checkmark';
import { ErrorIcon } from '@/components/icons/error';

const Toaster = memo(() => {
  const [position, setPosition] = useState<'top-center' | 'bottom-right'>(
    'top-center'
  );

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setPosition(
          entry.contentRect.width > 768 ? 'bottom-right' : 'top-center'
        );
      }
    });
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  return (
    <SonnerToaster
      swipeDirections={['left', 'right', 'top']}
      position={position}
      hotkey={['tab', 'Tab']}
      toastOptions={{
        duration: 5000,
        classNames: {
          actionButton:
            '!bg-transparent !text-foreground/50 hover:!text-foreground rtl:!pl-0 ltr:!pr-0',
          content: 'flex-1 font-main ms-4 whitespace-pre-line',
          icon: '!w-5 !h-5',
        },
      }}
      offset={{
        top: 'calc(env(safe-area-inset-top) + 32px)',
      }}
      icons={{
        error: <ErrorIcon />,
        success: <CheckmarkIcon />,
      }}
      className='select-none'
    />
  );
});

Toaster.displayName = 'Toaster';

export default Toaster;
