import type {
  MockMediaFile,
  MockMediaFolder,
  MockRole,
  MockTrustedDevice,
  MockTwoFactor,
  MockTwoFactorMethod,
  MockUser,
  MockUserRole,
  MockUserSession,
} from './store';
import type { PagePermission } from '@/types/permission';
import type { SettingsClient } from '@/types/settings';
import type { EntityID } from '@app/shared/types';
import type {
  BucketType,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import {
  CUSTOM_ROLE_VALUE,
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '@app/shared/validation/media-types';
import { phoneSchema } from '@app/shared/validation/rules';
import { APP_NAME } from '@/constants';

import { placeholderImage, settlesAt } from './lib/media';
import { emptyTwoFactor } from './lib/two-factor-model';

const MOCK_PASSWORD = 'Admin@1234';
const MOCK_ADMIN_EMAIL = 'admin@gmail.com';
export const CUSTOM_ROLE_NAME = 'صلاحيات مخصصة';

/** Bump when a seeded shape changes: data saved under an older one is dropped. */
export const SEED_VERSION = 5;

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

// The library's own-scope grants: an editor changes only what they created.
const EDITOR_MEDIA_ACTIONS: ReadonlySet<string> = new Set([
  'view',
  'create',
  'editOwn',
  'deleteOwn',
]);

const editorRole: MockRole = {
  id: seedId(),
  roleName: 'محرر',
  description: 'عرض وتعديل المستخدمين دون حذفهم، ورفع الملفات وإدارة ما رفعه',
  isActive: true,
  scope: ROLE_SCOPE.STANDARD,
  createdBy: ADMIN_USER_ID,
  createdAt: daysAgo(90),
  updatedAt: daysAgo(30),
  permissions: grant(
    (name, action) =>
      name === 'home' ||
      (name === 'users' && !action.startsWith('delete')) ||
      (name === 'media' && EDITOR_MEDIA_ACTIONS.has(action))
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

const mediaFolder = (
  name: string,
  parent: MockMediaFolder | null,
  createdBy: EntityID,
  age: number
): MockMediaFolder => ({
  id: seedId(),
  name,
  parentId: parent?.id ?? null,
  createdBy,
  createdAt: daysAgo(age),
  updatedAt: daysAgo(age),
});

// The first editor, who may edit and delete only what they created.
const EDITOR_USER_ID = others[0]?.id ?? ADMIN_USER_ID;

const logosFolder = mediaFolder('الشعارات', null, ADMIN_USER_ID, 60);
const contractsFolder = mediaFolder('العقود', null, ADMIN_USER_ID, 55);
const productsFolder = mediaFolder('صور المنتجات', null, EDITOR_USER_ID, 40);
const archiveFolder = mediaFolder('الأرشيف', null, ADMIN_USER_ID, 30);
const emptyFolder = mediaFolder('مجلد فارغ', null, EDITOR_USER_ID, 5);
const darkLogosFolder = mediaFolder(
  'نسخ داكنة',
  logosFolder,
  ADMIN_USER_ID,
  50
);
const invoicesFolder = mediaFolder(
  'الفواتير',
  archiveFolder,
  ADMIN_USER_ID,
  25
);
const invoices2025Folder = mediaFolder(
  '2025',
  invoicesFolder,
  ADMIN_USER_ID,
  20
);

const MEDIA_FOLDERS: MockMediaFolder[] = [
  emptyFolder,
  invoices2025Folder,
  invoicesFolder,
  darkLogosFolder,
  archiveFolder,
  productsFolder,
  contractsFolder,
  logosFolder,
];

interface FileSpec {
  name: string;
  mimeType: string;
  size: number;
  folder: MockMediaFolder | null;
  age: number;
  by?: EntityID;
  bucketType?: BucketType;
  dimensions?: [number, number];
  transition?: MockMediaFile['transition'];
  usages?: MockMediaFile['usages'];
  unfiled?: boolean;
}

const mediaFile = (spec: FileSpec, index: number): MockMediaFile => {
  const kind = spec.mimeType.startsWith('image/') ? 'image' : 'document';
  const extension = spec.name.split('.').pop() ?? '';
  return {
    id: seedId(),
    kind,
    displayName: spec.name,
    mimeType: spec.mimeType,
    sizeBytes: spec.size,
    bucketType: spec.bucketType ?? 'private',
    transition: spec.transition ?? null,
    width: spec.dimensions?.[0] ?? null,
    height: spec.dimensions?.[1] ?? null,
    blurhash: null,
    folderId: spec.folder?.id ?? null,
    uploadedBy: spec.by ?? ADMIN_USER_ID,
    unfiledAt: spec.unfiled ? daysAgo(spec.age) : null,
    url: placeholderImage(extension.toUpperCase(), (index * 47) % 360),
    createdAt: daysAgo(spec.age),
    updatedAt: daysAgo(spec.age),
    usages: spec.usages ?? [],
    settlesAt: spec.transition ? settlesAt(spec.transition) : null,
  };
};

const WEBP = 'image/webp';
const SVG = 'image/svg+xml';
const PDF = 'application/pdf';

const PRODUCT_FILES: FileSpec[] = Array.from({ length: 14 }, (_, i) => ({
  name: `منتج-${i + 1}.webp`,
  mimeType: WEBP,
  size: 60_000 + i * 7300,
  folder: productsFolder,
  age: 38 - i * 2,
  by: i % 3 === 0 ? ADMIN_USER_ID : EDITOR_USER_ID,
  bucketType: i % 4 === 1 ? 'public' : 'private',
  dimensions: [1200, 900],
  // A change caught mid-way: the sweep settles it ten minutes after the seed.
  transition: i === 5 ? 'to_public' : null,
}));

const MEDIA_FILE_SPECS: FileSpec[] = [
  ...PRODUCT_FILES,
  {
    name: 'الشعار الرئيسي.svg',
    mimeType: SVG,
    size: 4200,
    folder: logosFolder,
    age: 58,
    bucketType: 'public',
  },
  {
    name: 'رمز الشعار.webp',
    mimeType: WEBP,
    size: 31_000,
    folder: logosFolder,
    age: 57,
    dimensions: [512, 512],
  },
  {
    // Held by a record: it can be neither deleted nor, being public, unpublished.
    name: 'صورة الملف الشخصي.webp',
    mimeType: WEBP,
    size: 45_000,
    folder: logosFolder,
    age: 20,
    bucketType: 'public',
    dimensions: [400, 400],
    usages: [
      {
        label: 'صورة مستخدم',
        resource: 'users',
        recordId: ADMIN_USER_ID,
        name: admin.name,
        visibility: 'public',
      },
    ],
  },
  {
    name: 'الشعار الداكن.svg',
    mimeType: SVG,
    size: 3900,
    folder: darkLogosFolder,
    age: 49,
  },
  {
    name: 'عقد الخدمات.pdf',
    mimeType: PDF,
    size: 1_240_000,
    folder: contractsFolder,
    age: 54,
  },
  {
    name: 'عقد الصيانة.docx',
    mimeType: DOCX_MIME_TYPE,
    size: 86_000,
    folder: contractsFolder,
    age: 52,
  },
  {
    name: 'فاتورة يناير.pdf',
    mimeType: PDF,
    size: 220_000,
    folder: invoices2025Folder,
    age: 19,
  },
  {
    name: 'ميزانية 2025.xlsx',
    mimeType: XLSX_MIME_TYPE,
    size: 140_000,
    folder: invoices2025Folder,
    age: 18,
  },
  {
    // A visibility change finished, with only the stale copy left to remove.
    name: 'تقرير سنوي.pdf',
    mimeType: PDF,
    size: 3_100_000,
    folder: archiveFolder,
    age: 12,
    bucketType: 'public',
    transition: 'cleanup',
  },
  // Files whose record is gone: they wait out the retention period unfiled.
  {
    name: 'مسودة غلاف.webp',
    mimeType: WEBP,
    size: 52_000,
    folder: null,
    age: 5,
    dimensions: [800, 600],
    unfiled: true,
  },
  {
    name: 'مرفق قديم.pdf',
    mimeType: PDF,
    size: 410_000,
    folder: null,
    age: 2,
    unfiled: true,
  },
];

const MEDIA_FILES = MEDIA_FILE_SPECS.map(mediaFile);

const SEEDED_BACKUP_SET_ID = seedId();

/** The authenticator secret of `user7@gmail.com`, so a real app can be enrolled with it. */
export const SEEDED_TOTP_SECRET = 'mockTotpSecretForUserSeven000000';

/** `user7@gmail.com`'s acknowledged backup codes, each good once. */
export const SEEDED_BACKUP_CODES = Array.from(
  { length: 10 },
  (_, i) => `mock${i}-codes`
);

const seededMethod = (
  method: TwoFactorMethod,
  channel: OtpChannel | null,
  isDefault = false
): MockTwoFactorMethod => ({
  method,
  channel,
  contactKind: channel && contactKindOf(channel),
  isDefault,
});

const seededDevice = (age: number, userAgent: string): MockTrustedDevice => ({
  id: seedId(),
  userAgent,
  ipAddress: '203.0.113.7',
  lastUsedAt: daysAgo(age),
  createdAt: daysAgo(age + 10),
  expiresAt: new Date(Date.now() + (30 - age) * 86_400_000).toISOString(),
});

// Users who can sign in (the viewer role cannot) and hold what each needs: an
// email code a verified email, a phone code a verified phone.
const { 6: withTotp, 8: withEmailCode, 17: withPasskey } = others;

const TWO_FACTOR: MockTwoFactor[] = [
  {
    ...emptyTwoFactor(withTotp.id),
    enabled: true,
    methods: [
      seededMethod('totp', null, true),
      seededMethod('backup_code', null),
    ],
    totp: { secret: SEEDED_TOTP_SECRET, verified: true, lastStep: null },
    backupCodes: {
      codes: SEEDED_BACKUP_CODES,
      remaining: SEEDED_BACKUP_CODES.length,
      setId: SEEDED_BACKUP_SET_ID,
      acknowledgedSetId: SEEDED_BACKUP_SET_ID,
    },
    trustedDevices: [
      seededDevice(1, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0'),
      seededDevice(9, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1'),
    ],
  },
  {
    ...emptyTwoFactor(withPasskey.id),
    enabled: true,
    methods: [seededMethod('passkey', null, true), seededMethod('otp', 'sms')],
    passkeys: [
      {
        id: seedId(),
        name: 'مفتاح الحاسوب',
        credentialId: 'seeded-credential-1',
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt: daysAgo(20),
        updatedAt: daysAgo(20),
      },
    ],
  },
  {
    ...emptyTwoFactor(withEmailCode.id),
    enabled: true,
    methods: [seededMethod('otp', 'email', true)],
  },
];

const SESSION_DEVICES: readonly Pick<
  MockUserSession,
  'ipAddress' | 'userAgent'
>[] = [
  {
    ipAddress: '203.0.113.7',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  },
  {
    ipAddress: '198.51.100.23',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  },
  {
    ipAddress: '192.0.2.88',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  },
  {
    ipAddress: '2001:db8::1a2b',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  },
  { ipAddress: null, userAgent: null },
];

const sessionsOf = (user: MockUser, count: number, hoursApart: number) =>
  Array.from({ length: count }, (_, i): MockUserSession => ({
    id: seedId(),
    userId: user.id,
    ...SESSION_DEVICES[i % SESSION_DEVICES.length],
    createdAt: daysAgo((i + 1) * (hoursApart / 24)),
  }));

// The first editor holds more than two pages, so the list's paging shows.
const USER_SESSIONS: MockUserSession[] = [
  ...sessionsOf(admin, 3, 30),
  ...sessionsOf(others[0], 120, 7),
  ...sessionsOf(others[1], 2, 50),
  ...sessionsOf(others[2], 4, 11),
];

/**
 * A copy, since a table edits the array it is handed in place. Through JSON,
 * the form storage keeps it in: `structuredClone` is newer than the targets.
 */
// eslint-disable-next-line unicorn/prefer-structured-clone
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const seedRoles = () => copy(ROLES);
export const seedUsers = () => copy(USERS);
export const seedSettings = () => copy(SETTINGS);
export const seedFolders = () => copy(MEDIA_FOLDERS);
export const seedMediaFiles = () => copy(MEDIA_FILES);
export const seedTwoFactor = () => copy(TWO_FACTOR);
export const seedUserSessions = () => copy(USER_SESSIONS);
