import { memo, useCallback, useEffect, useState } from 'react';

import screenfull from 'screenfull';

import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { LabelTooltip } from '@/components/ui/tooltip';
import { DialogCloseButton } from '@/components/dialogs/dialog-close-button';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { LayoutSelector } from './layout-selector';
import { PreferencesSync } from './preferences-sync';
import { PresetSelector } from './preset-selector';
import { themeCustomizerDialog, useEditorStore } from './store';
import { StyleControls } from './style-controls';
import { ThemeModeSelector } from './theme-mode-selector';

const FullscreenButton = memo(() => {
  const [isFullscreen, setIsFullscreen] = useState(screenfull.isFullscreen);

  useEffect(() => {
    const onChange = () => setIsFullscreen(screenfull.isFullscreen);
    screenfull.on('change', onChange);
    return () => screenfull.off('change', onChange);
  }, []);

  // A denied request leaves the state unchanged and fires no `change` event.
  const toggleFullscreen = useCallback(() => {
    screenfull.toggle().catch(() => {});
  }, []);

  const icon = isFullscreen
    ? 'solar:quit-full-screen-linear'
    : 'solar:full-screen-linear';

  return (
    <Button
      variant='outline'
      size='none'
      className='w-full border-dashed px-2 py-1.5 hover:!border-primary hover:text-primary'
      onClick={toggleFullscreen}
    >
      <Icon icon={icon} className='size-5 opacity-60' />
      <span className='me-2'>
        {isFullscreen ? 'الخروج من ملء الشاشة' : 'ملء الشاشة'}
      </span>
    </Button>
  );
});
FullscreenButton.displayName = 'FullscreenButton';

const ThemeCustomizer = memo(() => {
  const handleReset = useCallback(() => useEditorStore.getState().reset(), []);

  return (
    <>
      <PreferencesSync />
      <StoreDialog
        dialog={themeCustomizerDialog}
        modal={false}
        side='left'
        className='w-[400px] gap-2 overflow-hidden'
      >
        <div className='pointer-events-none absolute top-0 size-80 -translate-y-1/2 rounded-full bg-gradient-to-br from-cyan-400/30 to-cyan-600/30 opacity-30 blur-3xl ltr:left-0 ltr:-translate-x-1/2 rtl:right-0 rtl:translate-x-1/2' />
        <div className='pointer-events-none absolute bottom-0 size-80 translate-y-1/2 rounded-full bg-gradient-to-tr from-red-400/30 to-pink-600/30 opacity-30 blur-3xl ltr:right-0 ltr:translate-x-1/2 rtl:left-0 rtl:-translate-x-1/2' />

        <DialogHeader className='p-4 pb-2 pt-[calc((var(--spacing)*4)+env(safe-area-inset-top))]'>
          <div className='flex items-center gap-2'>
            <div className='rounded-lg bg-primary/10 p-2'>
              <Icon icon='solar:settings-bold-duotone' className='size-4' />
            </div>
            <DialogTitle className='text-lg font-semibold'>التخصيص</DialogTitle>
            <div className='ms-auto flex flex-1 items-center justify-end gap-2'>
              <LabelTooltip label='إعادة ضبط'>
                <Button
                  variant='outline'
                  size='icon'
                  onClick={handleReset}
                  className='size-8'
                >
                  <Icon icon='solar:restart-linear' className='size-4' />
                </Button>
              </LabelTooltip>
              <DialogCloseButton />
            </div>
          </div>
          <DialogDescription className='sr-only'>
            تخصيص المظهر والتخطيط للوحة التحكم الخاصة بك.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className='h-full'>
          <div className='p-4 space-y-6'>
            <PresetSelector />
            <Separator />
            <StyleControls />
            <Separator />
            <ThemeModeSelector />
            <Separator />
            <LayoutSelector />
          </div>
        </ScrollArea>

        {screenfull.isEnabled && (
          <DialogFooter className='border-t p-4 pb-[calc((var(--spacing)*4)+env(safe-area-inset-bottom))]'>
            <FullscreenButton />
          </DialogFooter>
        )}
      </StoreDialog>
    </>
  );
});
ThemeCustomizer.displayName = 'ThemeCustomizer';

export { ThemeCustomizer };
