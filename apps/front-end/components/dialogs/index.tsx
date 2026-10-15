import { memo } from 'react';

import { ThemeCustomizer } from '@/components/theme-customizer';

import ImageZoomDialog from './image-zoom';
import ReauthDialog from './reauth';
import DialogUrlSync from './url-sync';

const GlobalDialogs = memo(() => {
  return (
    <>
      <DialogUrlSync />
      <ThemeCustomizer />
      <ImageZoomDialog />
      <ReauthDialog />
    </>
  );
});

GlobalDialogs.displayName = 'GlobalDialogs';

export default GlobalDialogs;
