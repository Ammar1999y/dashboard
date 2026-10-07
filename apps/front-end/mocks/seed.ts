import type { MockRole, MockUser, MockUserRole } from './store';
import type { PagePermission } from '@/types/permission';
import type { SectionClient } from '@/types/sections';
import type { SettingsClient } from '@/types/settings';

import {
  CUSTOM_ROLE_VALUE,
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import { phoneSchema } from '@app/shared/validation/rules';
import { APP_NAME } from '@/constants';

const MOCK_PASSWORD = 'Admin@1234';
const MOCK_ADMIN_EMAIL = 'admin@gmail.com';
export const CUSTOM_ROLE_NAME = 'صلاحيات مخصصة';

/** Bump when a seeded shape changes: data saved under an older one is dropped. */
export const SEED_VERSION = 3;

let seedCounter = 0;
/**
 * Deterministic, and every seeded row takes its id once, when this module
 * loads: a table seeded later, or seeded again after a reset, gets the same
 * ids, so a seeded row's reference to another always resolves and no two
 * seeded rows share one.
 */
const seedId = () =>
  `01900000-0000-7000-8000-${(++seedCounter).toString(16).padStart(12, '0')}`;

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

/** The canonical form the server stores. */
const phone = (input: string) => phoneSchema.parse(input);

const grant = (
  pick: (name: PagePermission['name'], action: string) => boolean
): PagePermission[] =>
  DEFAULT_PAGE_PERMISSIONS.map(({ name, availablePermissions }) => ({
    name,
    permissions: Object.fromEntries(
      availablePermissions.map((action) => [action, pick(name, action)])
    ),
  }));

/** The `role` a user row embeds. */
export const roleRef = ({
  id,
  roleName,
  scope,
  createdBy,
}: MockRole): MockUserRole => ({ id, roleName, scope, createdBy });

const ADMIN_USER_ID = seedId();

const adminRole: MockRole = {
  id: seedId(),
  roleName: 'مدير النظام',
  description: 'صلاحيات كاملة على كل الصفحات',
  isActive: true,
  scope: ROLE_SCOPE.SYSTEM,
  createdBy: null,
  createdAt: daysAgo(120),
  updatedAt: daysAgo(120),
  permissions: grant(() => true),
};

const editorRole: MockRole = {
  id: seedId(),
  roleName: 'محرر',
  description: 'عرض وتعديل المستخدمين دون حذفهم',
  isActive: true,
  scope: ROLE_SCOPE.STANDARD,
  createdBy: ADMIN_USER_ID,
  createdAt: daysAgo(90),
  updatedAt: daysAgo(30),
  permissions: grant(
    (name, action) =>
      name === 'home' || (name === 'users' && !action.startsWith('delete'))
  ),
};

const viewerRole: MockRole = {
  id: seedId(),
  roleName: 'مشاهد',
  description: 'عرض فقط',
  isActive: false,
  scope: ROLE_SCOPE.STANDARD,
  createdBy: ADMIN_USER_ID,
  createdAt: daysAgo(60),
  updatedAt: daysAgo(60),
  permissions: grant((_, action) => action === 'view'),
};

const ROLES: MockRole[] = [viewerRole, editorRole, adminRole];

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

const admin: MockUser = {
  id: ADMIN_USER_ID,
  name: 'مدير النظام',
  email: MOCK_ADMIN_EMAIL,
  emailVerified: true,
  phoneNumber: phone('0500000000'),
  phoneNumberVerified: true,
  isActive: true,
  roleId: adminRole.id,
  role: roleRef(adminRole),
  createdBy: null,
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
    phoneNumber: i % 4 === 0 ? null : phone(`050${1_000_000 + i}`),
    phoneNumberVerified: i % 4 === 1,
    isActive: i % 5 !== 4,
    ...(isCustom
      ? {
          roleId: CUSTOM_ROLE_VALUE,
          role: {
            id: seedId(),
            roleName: CUSTOM_ROLE_NAME,
            scope: ROLE_SCOPE.CUSTOM,
            createdBy: ADMIN_USER_ID,
          },
          permissions: grant((page) => page === 'home'),
        }
      : { roleId: role.id, role: roleRef(role) }),
    createdBy: ADMIN_USER_ID,
    createdAt: daysAgo(100 - i * 4),
    updatedAt: daysAgo(Math.max(0, 50 - i * 2)),
    password: MOCK_PASSWORD,
  };
});

const USERS: MockUser[] = [...[...others].reverse(), admin];

const SECTIONS: SectionClient[] = [
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
        subtitle: '',
        description: 'مواقع سريعة ومتجاوبة',
        isActive: true,
        order: 0,
      },
      {
        id: seedId(),
        title: 'تطبيقات الجوال',
        subtitle: '',
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
    updatedAt: daysAgo(45),
    items: null,
  },
];

const SETTINGS: SettingsClient = {
  id: seedId(),
  siteTitle: APP_NAME,
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
  socialAccounts: null,
  contactInfo: null,
  navLinks: null,
  createdAt: daysAgo(120),
  updatedAt: daysAgo(7),
};

/**
 * A copy, since a table edits the array it is handed in place. Through JSON,
 * the form storage keeps it in: `structuredClone` is newer than the targets.
 */
// eslint-disable-next-line unicorn/prefer-structured-clone
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const seedRoles = () => copy(ROLES);
export const seedUsers = () => copy(USERS);
export const seedSections = () => copy(SECTIONS);
export const seedSettings = () => copy(SETTINGS);
