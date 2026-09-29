import { memo } from 'react';

import { ThemeCustomizer } from '@/components/theme-customizer';

import ImageZoomDialog from './image-zoom';
import DialogUrlSync from './url-sync';

const GlobalDialogs = memo(() => {
  return (
    <>
      <DialogUrlSync />
      <ThemeCustomizer />
      <ImageZoomDialog />
    </>
  );
});

GlobalDialogs.displayName = 'GlobalDialogs';

export default GlobalDialogs;
