import type { ToasterProps } from 'sonner';

import { memo } from 'react';

import { Toaster as SonnerToaster } from 'sonner';

import { down, useMediaQuery } from '@/hooks/use-media-query';
import { CheckmarkIcon } from '@/components/icons/checkmark';
import { ErrorIcon } from '@/components/icons/error';

const MOBILE_QUERY = down('md');

const SWIPE_DIRECTIONS: ToasterProps['swipeDirections'] = [
  'left',
  'right',
  'top',
];
const HOTKEY = ['tab', 'Tab'];
const OFFSET: ToasterProps['offset'] = {
  top: 'calc(env(safe-area-inset-top) + 32px)',
};
const TOAST_OPTIONS: ToasterProps['toastOptions'] = {
  duration: 5000,
  classNames: {
    actionButton:
      '!bg-transparent !text-foreground/50 hover:!text-foreground rtl:!pl-0 ltr:!pr-0',
    content: 'flex-1 font-main ms-4 whitespace-pre-line',
    icon: '!w-5 !h-5',
  },
};
const ICONS: ToasterProps['icons'] = {
  error: <ErrorIcon />,
  success: <CheckmarkIcon />,
};

const Toaster = memo(() => {
  const isMobile = useMediaQuery(MOBILE_QUERY);

  return (
    <SonnerToaster
      swipeDirections={SWIPE_DIRECTIONS}
      position={isMobile ? 'top-center' : 'bottom-right'}
      hotkey={HOTKEY}
      toastOptions={TOAST_OPTIONS}
      offset={OFFSET}
      icons={ICONS}
      className='select-none'
    />
  );
});

Toaster.displayName = 'Toaster';

export default Toaster;
