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

      {
        title: 'الأقسام',
        path: '/dash/sections',
        icon: 'icon-park-twotone:layout-five',
        children: [
          {
            title: 'إضافة قسم',
            hidden: true,
            path: '/dash/sections/new',
          },
          {
            title: 'تعديل القسم',
            hidden: true,
            path: '/dash/sections/[id]/edit',
          },
        ],
      },

      {
        title: 'إداره المشاريع',
        path: '/dash/projects',
        icon: 'uim:briefcase',
        children: [
          {
            title: 'التصنيفات',
            path: '/dash/projects/categories',
            children: [
              {
                title: 'إضافة تصنيف',
                hidden: true,
                path: '/dash/projects/categories/new',
              },
              {
                title: 'تعديل التصنيف',
                hidden: true,
                path: '/dash/projects/categories/[id]/edit',
              },
            ],
          },
          {
            title: 'المشاريع',
            path: '/dash/projects',
            exactMatch: true,
            children: [
              {
                title: 'إضافة مشروع',
                hidden: true,
                path: '/dash/projects/new',
              },
              {
                title: 'تعديل المشروع',
                hidden: true,
                path: '/dash/projects/[id]/edit',
              },
            ],
          },
        ],
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
