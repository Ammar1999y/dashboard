import { memo } from 'react';

import { APP_NAME } from '@/constants';
import { createDialog, DIALOG_URL_IDS } from '@/lib/dialogs';

import { DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NavVertical } from '@/components/dash/nav';
import { DialogCloseButton } from '@/components/dialogs/dialog-close-button';
import { DialogToggle } from '@/components/dialogs/dialog-toggle';
import { StoreDialog } from '@/components/dialogs/store-dialog';
import Menu from '@/components/icons/menu';

import Logo from './logo';
import { dashboardNav } from './nav-data';

const mobileMenuDialog = createDialog({
  urlId: DIALOG_URL_IDS.mobileMenu,
  restoreFromUrl: true,
});

export const MobileMenu = memo(() => (
  <>
    <DialogToggle
      dialog={mobileMenuDialog}
      variant='ghost'
      size='icon'
      aria-label='القائمة'
    >
      <Menu className='size-6' />
    </DialogToggle>
    <StoreDialog
      dialog={mobileMenuDialog}
      modal={false}
      side='right'
      className='w-72 px-2'
    >
      <div className='flex h-[--layout-header-height] items-center pb-4 pe-2 ps-6 pt-[--layout-header-padding-top] space-x-4'>
        <Logo className='h-full max-w-12' />
        <DialogTitle className='text-xl font-bold'>{APP_NAME}</DialogTitle>
        <div className='flex flex-1'>
          <DialogCloseButton className='ms-auto' />
        </div>
      </div>
      <ScrollArea className='h-full'>
        <NavVertical data={dashboardNav} />
      </ScrollArea>
    </StoreDialog>
  </>
));
MobileMenu.displayName = 'MobileMenu';
