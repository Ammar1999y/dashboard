import type { LibraryFile, LibraryFolder } from '@/lib/media/schemas';
import type { PagePermission } from '@/types/permission';
import type { SettingsClient } from '@/types/settings';
import type { UserDetail } from '@/types/user';
import type { oauthResult as oauthResultEntry } from '@app/shared/api/better-auth';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type {
  BucketType,
  ContactKind,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';
import type { StoredPreferences } from '@app/shared/validation/preferences';
import type { ReauthMethod } from '@app/shared/validation/reauth';
import type * as z from 'zod';

import { ROLE_SCOPE } from '@app/shared/permissions/constants';

import { singleton, table } from './lib/db';
import {
  seedFolders,
  seedMediaFiles,
  seedRoles,
  seedSettings,
  seedTwoFactor,
  seedUsers,
  seedUserSessions,
} from './seed';

export { roleRef } from './seed';

// The rows as the server stores them. Handlers answer with the API types, which
// leave out what the server keeps to itself (a role's scope, a password).

type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE];

export interface MockRole {
  id: EntityID;
  roleName: string;
  description: string | null;
  isActive: boolean;
  scope: RoleScope;
  permissions: PagePermission[];
  createdBy: EntityID | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A custom role exists only here, embedded in its one user, so this carries
 * what the server's `roles` row would for it.
 */
export interface MockUserRole {
  id: EntityID;
  roleName: string;
  scope: RoleScope;
  createdBy: EntityID | null;
}

/** What the `users` row holds: every field the detail answers, none optional. */
type StoredUser = Pick<
  UserDetail,
  | 'id'
  | 'name'
  | 'email'
  | 'emailVerified'
  | 'phoneNumber'
  | 'phoneNumberVerified'
  | 'isActive'
  | 'roleId'
  | 'createdAt'
  | 'updatedAt'
>;

export interface MockUser extends StoredUser {
  role: MockUserRole | null;
  /** A custom role's matrix, held on its one user. */
  permissions?: PagePermission[];
  createdBy: EntityID | null;
  password: string;
}

export interface MockSession {
  session: {
    id: string;
    token: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: null;
    createdAt: string;
    updatedAt: string;
  };
}

export const users = table<MockUser>('users', seedUsers);
export const roles = table<MockRole>('roles', seedRoles);
export const settings = singleton<SettingsClient | null>(
  'settings',
  seedSettings
);
export const session = singleton<MockSession | null>('session', () => null);

/** A record that holds a library file, as the server's usage sources report it. */
export interface MockUsage {
  label: string;
  resource: DashboardPage;
  recordId: EntityID;
  /** The record's own name, as its source reads it. */
  name: string | null;
  /** Whether the record is published content, which keeps its file public. */
  visibility: BucketType;
}

/**
 * A library file as the server stores it. What a listing reads from other rows
 * (the uploader's name, whether a record holds it) is added on the way out.
 */
export interface MockMediaFile extends Omit<
  LibraryFile,
  'uploadedByName' | 'inUse'
> {
  usages: MockUsage[];
  /** When a visibility change in flight resolves, as the nightly sweep resolves it. */
  settlesAt: string | null;
}

/** A folder as the server stores it; its creator's name and counts are read on the way out. */
export type MockMediaFolder = Omit<
  LibraryFolder,
  'createdByName' | 'subfolderCount' | 'fileCount'
>;

export const folders = table<MockMediaFolder>('media-folders', seedFolders);
export const mediaFiles = table<MockMediaFile>('media-files', seedMediaFiles);

/** The window a proof opens, as the server keys it: by session, owned by its user. */
export interface MockReauthWindow {
  sessionId: string;
  userId: EntityID;
  method: ReauthMethod;
  expiresAt: string;
}

export const reauth = singleton<MockReauthWindow | null>('reauth', () => null);

/** One enrolled method, as `two_factor_methods` keeps it: intent, not capability. */
export interface MockTwoFactorMethod {
  method: TwoFactorMethod;
  /** Set for `otp` only: the delivery preference. */
  channel: OtpChannel | null;
  /** Set for `otp` only: which possession it proves. */
  contactKind: ContactKind | null;
  isDefault: boolean;
}

export interface MockPasskey {
  id: EntityID;
  name: string | null;
  /** The authenticator's own id, which a registration must not repeat. */
  credentialId: string;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MockTrustedDevice {
  id: EntityID;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * A user's second-factor state, one row per user that has any, keyed by the
 * user's id. `methods` is what they enrolled; `totp`, `backupCodes` and
 * `passkeys` are what each can do. A challenge offers a method only when both
 * hold (`offeredMethods`).
 */
export interface MockTwoFactor {
  id: EntityID;
  enabled: boolean;
  methods: MockTwoFactorMethod[];
  /** The authenticator secret as the server keeps it; `verified` once a code proved it. */
  totp: {
    secret: string;
    verified: boolean;
    /** The newest step a code was accepted for; an older or equal one is a replay. */
    lastStep: number | null;
  } | null;
  /** The current set, with the set the user acknowledged saving. */
  backupCodes: {
    codes: string[];
    remaining: number;
    setId: string | null;
    acknowledgedSetId: string | null;
  } | null;
  passkeys: MockPasskey[];
  trustedDevices: MockTrustedDevice[];
}

export const twoFactor = table<MockTwoFactor>('two-factor', seedTwoFactor);

export type MockProofKind =
  | 'totp-enrolment'
  | 'otp'
  | 'passkey-grant'
  | 'two-factor-proven'
  | 'reauth-passkey';

/** What the server keeps in `verifications`: short-lived, one purpose each. */
export interface MockProof {
  id: EntityID;
  userId: EntityID;
  kind: MockProofKind;
  /**
   * What it is for: `<purpose>:<destination>` for a code (`two_factor:a@b.co`),
   * the token for a passkey grant, the session for a device-trust proof.
   */
  key: string;
  /** The code a mock send "delivered". */
  value: string;
  sends: number;
  sentAt: string;
  expiresAt: string;
}

export const proofs = table<MockProof>('proofs', () => []);

/** The captcha tokens the verifier has judged: it accepts each one once. */
export const spentCaptchas = singleton<string[]>('spent-captchas', () => []);

/**
 * What the server keeps between a first factor and its second: the challenge
 * cookie and the state behind it. One browser holds one, and a new sign-in
 * replaces it.
 */
export interface MockChallenge {
  userId: EntityID;
  /** The option ids the first factor issued; verification narrows them, never widens. */
  options: string[];
  defaultMethod: string | null;
  firstFactor: 'password' | 'passwordless' | 'google';
  /** The contact the first factor proved, which a code to it would prove again. */
  excludeContactKind: ContactKind | null;
  rememberMe: boolean;
  /** Failed attempts, shared by every method: the sixth ends the challenge. */
  attempts: number;
  /** The passkey options of the ceremony in progress, spent by its verification. */
  ceremony: string | null;
  expiresAt: string;
}

export const challenge = singleton<MockChallenge | null>(
  'challenge',
  () => null
);

/** The grant a password reset mints for an account that holds a second factor. */
export interface MockRecoveryGrant {
  /** The token the client holds. */
  id: string;
  userId: EntityID;
  excludeContactKind: ContactKind;
  options: string[];
  /** Failed attempts, shared by every method. */
  attempts: number;
  expiresAt: string;
}

export const recoveryGrants = table<MockRecoveryGrant>(
  'recovery-grants',
  () => []
);

/**
 * The outcome Google's callback left for `/oauth/result`, which hands it over
 * once. `body` is what that answers (`null` for a refused sign-in).
 */
export interface MockOAuthResult {
  body: z.input<typeof oauthResultEntry.response.raw> | null;
  expiresAt: string;
}

export const oauthResult = singleton<MockOAuthResult | null>(
  'oauth-result',
  () => null
);

/**
 * A session of a user besides the one the mocks sign in with, which is the
 * `session` singleton and is added to its user's list as the current one.
 */
export interface MockUserSession {
  id: EntityID;
  userId: EntityID;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export const userSessions = table<MockUserSession>(
  'user-sessions',
  seedUserSessions
);

/** What the server keeps in `user_preferences`, one row per user that saved. */
export interface MockPreferences {
  /** The user's id. */
  id: EntityID;
  ui: StoredPreferences;
  updatedAt: string;
}

export const preferences = table<MockPreferences>('preferences', () => []);

export const toUserClient = ({
  password: _,
  createdBy: __,
  role,
  ...user
}: MockUser) => ({
  ...user,
  role: role && { id: role.id, roleName: role.roleName },
});

/** The signed-in user's row, or `undefined` once the account is gone. */
export const currentUser = () => {
  const id = session.get()?.user.id;
  return id ? users.find(id) : undefined;
};

/** What the server's `roles` row says of a user's role; `undefined` without one. */
export function roleOf(
  user: MockUser
): { isActive: boolean; permissions: PagePermission[] } | undefined {
  if (user.role?.scope === ROLE_SCOPE.CUSTOM)
    return { isActive: true, permissions: user.permissions ?? [] };
  return user.roleId ? roles.find(user.roleId) : undefined;
}
