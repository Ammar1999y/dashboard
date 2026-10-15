import type { NavSection } from '@/components/dash/nav';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';
import { MSG_ACCOUNT_PAGE } from '@/constants/messages';

import { ACCOUNT_PATH } from '../auth/paths';

export const dashboardNav: readonly NavSection[] = [
  {
    name: 'الأساسي',
    items: [
      {
        title: DASHBOARD_PAGE_LABELS.home,
        path: '/dash',
        icon: 'solar:home-2-bold-duotone',
      },

      {
        title: DASHBOARD_PAGE_LABELS.media,
        path: '/dash/media',
        icon: 'solar:folder-bold-duotone',
      },
    ],
  },
  {
    name: 'الاعدادات',
    items: [
      {
        title: 'الاعدادات',
        path: '/dash/settings',
        icon: 'solar:settings-bold-duotone',
      },
      {
        title: MSG_ACCOUNT_PAGE,
        hidden: true,
        path: ACCOUNT_PATH,
      },
    ],
  },
  {
    name: 'الإدارة',
    items: [
      {
        title: DASHBOARD_PAGE_LABELS.users,
        path: '/dash/users',
        icon: 'solar:user-bold-duotone',
        children: [
          {
            title: 'إضافة مستخدم',
            hidden: true,
            path: '/dash/users/new',
          },
          {
            title: 'تعديل المستخدم',
            hidden: true,
            path: '/dash/users/[id]/edit',
          },
        ],
      },
      {
        title: DASHBOARD_PAGE_LABELS.permissions,
        path: '/dash/permissions',
        icon: 'solar:key-square-2-bold-duotone',
        children: [
          {
            title: 'إضافة صلاحية',
            hidden: true,
            path: '/dash/permissions/new',
          },
          {
            title: 'تعديل الصلاحية',
            hidden: true,
            path: '/dash/permissions/[id]/edit',
          },
        ],
      },
    ],
  },
];
