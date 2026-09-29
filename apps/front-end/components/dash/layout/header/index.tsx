import { memo } from 'react';

import Logo from '../logo';
import { MobileMenu } from '../mobile-menu';
import { AccountMenu } from './account-menu';
import { Breadcrumbs } from './breadcrumbs';
import { RefreshButton } from './refresh-button';
import { SettingsButton } from './settings-button';

export type HeaderStart = 'menu' | 'logo';

export const Header = memo(({ start }: { start?: HeaderStart }) => (
  <header
    data-slot='slash-layout-header'
    className='sticky inset-x-0 top-0 z-app-bar flex h-[--layout-header-height] shrink-0 grow-0 flex-col items-start justify-between bg-background/60 px-4 pb-4 pt-[--layout-header-padding-top] backdrop-blur-xl space-y-2 md:pe-8 md:ps-3'
  >
    <div className='flex h-full w-full flex-1 items-center justify-between'>
      <div className='flex h-full items-center'>
        {start === 'menu' && <MobileMenu />}
        {start === 'logo' && <Logo className='h-full max-w-16' />}

        <div className='ms-4 hidden md:block'>
          <Breadcrumbs />
        </div>
      </div>

      <div className='flex items-center space-x-3'>
        <RefreshButton />
        <SettingsButton />
        <AccountMenu />
      </div>
    </div>
    <div className='ms-2 md:hidden'>
      <Breadcrumbs />
    </div>
  </header>
));
Header.displayName = 'Header';
