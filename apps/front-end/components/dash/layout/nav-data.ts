import type { NavSection } from '@/components/dash/nav';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';

export const dashboardNav: readonly NavSection[] = [
  {
    name: 'الأساسي',
    items: [
      {
        title: DASHBOARD_PAGE_LABELS.home,
        path: '/dash',
        icon: 'solar:home-2-bold-duotone',
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
