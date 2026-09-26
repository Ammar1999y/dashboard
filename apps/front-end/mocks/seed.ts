import type { MockUser } from './store';
import type { CategoryClient } from '@/types/categories';
import type { PagePermission, PermissionClient } from '@/types/permission';
import type { ProjectClient } from '@/types/projects';
import type { SectionClient } from '@/types/sections';
import type { SettingsClient } from '@/types/settings';

import {
  CUSTOM_ROLE_VALUE,
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';

const MOCK_PASSWORD = 'Admin@1234';
const MOCK_ADMIN_EMAIL = 'admin@gmail.com';
export const CUSTOM_ROLE_NAME = 'صلاحيات مخصصة';

let seedCounter = 0;
/**
 * Deterministic, so a role or category id a seeded row points at is the same
 * id whichever table was seeded and saved first.
 */
const seedId = () =>
  `01900000-0000-7000-8000-${(++seedCounter).toString(16).padStart(12, '0')}`;

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

const grant = (
  pick: (name: PagePermission['name'], action: string) => boolean
): PagePermission[] =>
  DEFAULT_PAGE_PERMISSIONS.map(({ name, availablePermissions }) => ({
    name,
    permissions: Object.fromEntries(
      availablePermissions.map((action) => [action, pick(name, action)])
    ),
  }));

const adminRole: PermissionClient = {
  id: seedId(),
  roleName: 'مدير النظام',
  description: 'صلاحيات كاملة على كل الصفحات',
  isActive: true,
  scope: ROLE_SCOPE.SYSTEM,
  createdAt: daysAgo(120),
  updatedAt: daysAgo(120),
  permissions: grant(() => true),
};

const editorRole: PermissionClient = {
  id: seedId(),
  roleName: 'محرر',
  description: 'عرض وتعديل المستخدمين دون حذفهم',
  isActive: true,
  scope: ROLE_SCOPE.STANDARD,
  createdAt: daysAgo(90),
  updatedAt: daysAgo(30),
  permissions: grant(
    (name, action) =>
      name === 'home' || (name === 'users' && !action.startsWith('delete'))
  ),
};

const viewerRole: PermissionClient = {
  id: seedId(),
  roleName: 'مشاهد',
  description: 'عرض فقط',
  isActive: false,
  scope: ROLE_SCOPE.STANDARD,
  createdAt: daysAgo(60),
  updatedAt: daysAgo(60),
  permissions: grant((_, action) => action === 'view'),
};

export const seedRoles = (): PermissionClient[] => [
  viewerRole,
  editorRole,
  adminRole,
];

const NAMES = [
  'أحمد علي',
  'سارة محمد',
  'خالد عبدالله',
  'نورة سعد',
  'محمد حسن',
  'ريم فهد',
  'عمر يوسف',
  'هند إبراهيم',
  'فيصل ناصر',
  'لمى عادل',
  'ياسر سالم',
  'دانة ماجد',
  'طارق وليد',
  'جود سامي',
  'بدر منصور',
  'مها طلال',
  'سلمان راشد',
  'أروى هشام',
  'زياد كريم',
  'غادة مازن',
  'ماجد فؤاد',
  'رنا بسام',
];

const roleRef = (role: PermissionClient) => ({
  id: role.id,
  roleName: role.roleName,
  scope: role.scope,
});

export const seedUsers = (): MockUser[] => {
  const admin: MockUser = {
    id: seedId(),
    name: 'مدير النظام',
    email: MOCK_ADMIN_EMAIL,
    emailVerified: true,
    phoneNumber: '+966500000000',
    phoneNumberVerified: true,
    isActive: true,
    roleId: adminRole.id,
    role: roleRef(adminRole),
    createdAt: daysAgo(120),
    updatedAt: daysAgo(10),
    password: MOCK_PASSWORD,
  };

  const others = NAMES.map((name, i): MockUser => {
    const isCustom = i % 3 === 2;
    const role = i % 3 === 0 ? editorRole : viewerRole;
    return {
      id: seedId(),
      name,
      email: `user${i + 1}@gmail.com`,
      emailVerified: i % 2 === 0,
      phoneNumber: i % 4 === 0 ? null : `+96650${String(1_000_000 + i)}`,
      phoneNumberVerified: i % 4 === 1,
      isActive: i % 5 !== 4,
      ...(isCustom
        ? {
            roleId: CUSTOM_ROLE_VALUE,
            role: {
              id: seedId(),
              roleName: CUSTOM_ROLE_NAME,
              scope: ROLE_SCOPE.CUSTOM,
            },
            permissions: grant((page) => page === 'home'),
          }
        : { roleId: role.id, role: roleRef(role) }),
      createdAt: daysAgo(100 - i * 4),
      updatedAt: daysAgo(Math.max(0, 50 - i * 2)),
      password: MOCK_PASSWORD,
    };
  });

  return [...[...others].reverse(), admin];
};

const webCategory: CategoryClient = {
  id: seedId(),
  title: 'تطوير الويب',
  isActive: true,
  createdAt: daysAgo(80),
  updatedAt: daysAgo(80),
};

const mobileCategory: CategoryClient = {
  id: seedId(),
  title: 'تطبيقات الجوال',
  isActive: true,
  createdAt: daysAgo(70),
  updatedAt: daysAgo(20),
};

const designCategory: CategoryClient = {
  id: seedId(),
  title: 'تصميم الهوية',
  isActive: false,
  createdAt: daysAgo(40),
  updatedAt: daysAgo(40),
};

export const seedCategories = (): CategoryClient[] => [
  designCategory,
  mobileCategory,
  webCategory,
];

export const seedProjects = (): ProjectClient[] => [
  {
    id: seedId(),
    title: 'متجر إلكتروني',
    description: 'منصة بيع متكاملة مع بوابة دفع',
    link: 'https://example.com/store',
    categoryId: webCategory.id,
    isActive: true,
    createdAt: daysAgo(15),
    updatedAt: daysAgo(5),
  },
  {
    id: seedId(),
    title: 'تطبيق حجوزات',
    description: 'تطبيق لحجز المواعيد للعيادات',
    link: 'https://example.com/booking',
    categoryId: mobileCategory.id,
    isActive: true,
    createdAt: daysAgo(35),
    updatedAt: daysAgo(35),
  },
  {
    id: seedId(),
    title: 'هوية شركة ناشئة',
    description: 'شعار ودليل استخدام الهوية',
    categoryId: designCategory.id,
    isActive: false,
    createdAt: daysAgo(55),
    updatedAt: null,
  },
];

export const seedSections = (): SectionClient[] => [
  {
    id: seedId(),
    slug: 'services',
    title: 'خدماتنا',
    subtitle: 'ما نقدمه لعملائنا',
    shortDescription: 'حلول تقنية متكاملة',
    description: null,
    isActive: true,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(3),
    items: [
      {
        id: seedId(),
        title: 'تطوير المواقع',
        description: 'مواقع سريعة ومتجاوبة',
        isActive: true,
        order: 0,
      },
      {
        id: seedId(),
        title: 'تطبيقات الجوال',
        description: 'تطبيقات iOS و Android',
        isActive: true,
        order: 1,
      },
    ],
  },
  {
    id: seedId(),
    slug: 'about',
    title: 'من نحن',
    subtitle: 'تعرف علينا',
    shortDescription: 'فريق تقني بخبرة طويلة',
    description: null,
    isActive: true,
    createdAt: daysAgo(45),
    updatedAt: null,
    items: [],
  },
];

export const seedSettings = (): SettingsClient => ({
  id: seedId(),
  siteTitle: 'البيت التقني',
  siteDescription: 'حلول تقنية متكاملة للشركات',
  footerDescription: 'نبني منتجات رقمية تدوم',
  copyrightText: 'جميع الحقوق محفوظة',
  primaryColor: '#02B199',
  fonts: {
    googleFont: null,
    letterSpacing: 0,
    lineHeight: 1,
    fontSizeMultiplier: 1,
  },
  socialAccounts: [],
  contactInfo: [],
  navLinks: [],
  createdAt: daysAgo(120),
  updatedAt: daysAgo(7),
});
