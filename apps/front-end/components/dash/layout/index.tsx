import type { HeaderStart } from './header';

import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { useSession } from '@/lib/auth/use-session';
import { cn } from '@/lib/utils';

import { ThemeLayout, useThemeLayout } from '@/utils/store/setting';

import { down, useMediaQuery } from '@/hooks/use-media-query';

import { saveRedirectPath } from '../auth/redirect-path';
import { Header } from './header';
import { DashboardSidebar } from './sidebar';
import { DashboardTopNav } from './top-nav';

const MOBILE_QUERY = down('md2');

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const themeLayout = useThemeLayout();
  const { replace, asPath } = useRouter();
  const { data: session, isPending } = useSession();
  const userId = session?.user.id;

  useEffect(() => {
    if (isPending || userId) return;
    saveRedirectPath(asPath);
    void replace('/dash/sign-in');
  }, [isPending, userId, asPath, replace]);

  if (isPending || !userId) return null;

  const horizontal = !isMobile && themeLayout === ThemeLayout.Horizontal;
  const sidebar = !isMobile && !horizontal;
  const mini = themeLayout === ThemeLayout.Mini;
  let headerStart: HeaderStart | undefined;
  if (isMobile) headerStart = 'menu';
  else if (horizontal) headerStart = 'logo';

  // Only the chrome around `<main>` varies, never its place in the tree:
  // crossing the breakpoint or switching layout must not remount the page.
  return (
    <div
      data-slot='slash-layout-root'
      className='min-h-screen w-full bg-background'
    >
      {sidebar && <DashboardSidebar mini={mini} />}
      <div
        className={cn(
          'relative flex min-h-screen w-full flex-col transition-[padding] duration-300 ease-in-out',
          sidebar &&
            (mini ? 'ps-[--layout-nav-width-mini]' : 'ps-[--layout-nav-width]')
        )}
      >
        <Header start={headerStart} />
        {horizontal && <DashboardTopNav />}
        <main className='container-padding container rounded-lg pb-6 pt-8 transition-[max-width] duration-300 ease-in-out'>
          {children}
        </main>
      </div>
    </div>
  );
}
