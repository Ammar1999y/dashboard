import type { Executor, Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpChannel,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  passkeys,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';

import {
  CONTACT_KINDS,
  contactKindOf,
  optionId,
} from '@app/shared/validation/enums';
import {
  ENABLED_TWO_FACTOR_METHODS,
  isTwoFactorOtpChannelEnabled,
} from '@app/shared/validation/two-factor';

import { revokePendingTwoFactorCodes } from '@/lib/otp/revoke';

export interface EnrolledMethod {
  method: TwoFactorMethod;
  /** Set for `otp` and nothing else, per `chk_two_factor_method_channel`. */
  channel: OtpChannel | null;
  /** Generated from `channel`. The identity half of an `otp` enrolment. */
  contactKind: ContactKind | null;
  isDefault: boolean;
}

/** Intent and capability read in one pass — see `two_factor_methods` in `db/schema.ts`. */
export interface EnrolmentState {
  enabled: boolean;
  intent: EnrolledMethod[];
  capability: {
    totpVerified: boolean;
    backupCodesReady: boolean;
    hasPasskey: boolean;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
}

/** `id` is `optionId`'s, which everything downstream keys on. */
export interface OfferedOption {
  id: string;
  method: TwoFactorMethod;
  contactKind: ContactKind | null;
  /** Delivery preference for an `otp` option; never part of its identity. */
  channel: OtpChannel | null;
}

export function asContactKind(value: unknown): ContactKind | null {
  return CONTACT_KINDS.find((kind) => kind === value) ?? null;
}

export function matchesEnrolment(
  entry: EnrolledMethod,
  method: TwoFactorMethod,
  contactKind: ContactKind | null | undefined
): boolean {
  return (
    entry.method === method &&
    (method !== 'otp' || entry.contactKind === contactKind)
  );
}

// `backup_code` is also excluded from auto-routing, so a routine login never spends recovery material.
const METHOD_PRIORITY: Readonly<Record<TwoFactorMethod, number>> = {
  passkey: 0,
  totp: 1,
  otp: 2,
  backup_code: 3,
};

const AUTO_ROUTABLE = (option: OfferedOption): boolean =>
  option.method !== 'backup_code';

export async function listEnrolledMethods(
  userId: EntityID,
  executor: Executor = db
): Promise<EnrolledMethod[]> {
  const rows = await executor
    .select({
      method: twoFactorMethods.method,
      channel: twoFactorMethods.channel,
      contactKind: twoFactorMethods.contactKind,
      isDefault: twoFactorMethods.isDefault,
    })
    .from(twoFactorMethods)
    .where(eq(twoFactorMethods.userId, userId))
    // Deterministic: clients offer methods in response order.
    .orderBy(twoFactorMethods.method, twoFactorMethods.contactKind);
  return rows.map((row) => ({
    method: row.method,
    channel: row.channel,
    contactKind: asContactKind(row.contactKind),
    isDefault: row.isDefault,
  }));
}

// ⚠️ A caller inside a transaction must pass it as `executor`, or a second pooled
// connection is taken and the pool can deadlock.
export async function readEnrolmentState(
  userId: EntityID,
  executor: Executor = db
): Promise<EnrolmentState> {
  const [intent, [credential], [passkeyRow], [user]] = await Promise.all([
    listEnrolledMethods(userId, executor),
    executor
      .select({
        secret: twoFactorCredentials.secret,
        verified: twoFactorCredentials.verified,
        acknowledgedSetId: twoFactorCredentials.backupCodesAcknowledgedSetId,
        setId: twoFactorCredentials.backupCodesSetId,
        remaining: twoFactorCredentials.backupCodesRemaining,
      })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, userId))
      .limit(1),
    executor
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1),
    executor
      .select({
        twoFactorEnabled: users.twoFactorEnabled,
        emailVerified: users.emailVerified,
        phoneNumberVerified: users.phoneNumberVerified,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);

  return {
    enabled: user?.twoFactorEnabled === true,
    intent,
    capability: {
      totpVerified:
        Boolean(credential?.secret) && credential?.verified === true,
      // ⚠️ Dropping any condition advertises codes the user does not have. The
      // null check matters: a row with no set has both ids NULL.
      backupCodesReady:
        credential?.acknowledgedSetId != null &&
        credential.acknowledgedSetId === credential.setId &&
        credential.remaining > 0,
      hasPasskey: passkeyRow != null,
      emailVerified: user?.emailVerified === true,
      phoneVerified: user?.phoneNumberVerified === true,
    },
  };
}

/**
 * `excludeContactKind` is the possession the first factor already proved.
 *
 * ⚠️ `scripts/check-two-factor-rollout.ts` mirrors this intersection in SQL.
 */
export function offeredMethods(
  state: EnrolmentState,
  excludeContactKind?: ContactKind
): OfferedOption[] {
  const { capability } = state;
  const offered = state.intent.filter(({ method, channel }) => {
    if (!ENABLED_TWO_FACTOR_METHODS.includes(method)) return false;
    switch (method) {
      case 'totp': {
        return capability.totpVerified;
      }
      case 'backup_code': {
        return capability.backupCodesReady;
      }
      case 'passkey': {
        return capability.hasPasskey;
      }
      case 'otp': {
        // Channel-granular: removing a channel is how an operator stops the
        // second factor sharing a mailbox with recovery.
        if (!channel || !isTwoFactorOtpChannelEnabled(channel)) return false;
        const kind = contactKindOf(channel);
        if (kind === excludeContactKind) return false;
        return kind === 'email'
          ? capability.emailVerified
          : capability.phoneVerified;
      }
    }
  });

  return offered
    .map((row) => ({
      id: optionId(row.method, row.contactKind),
      method: row.method,
      contactKind: row.contactKind,
      channel: row.channel,
      isDefault: row.isDefault,
    }))
    .toSorted((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const byPriority = METHOD_PRIORITY[a.method] - METHOD_PRIORITY[b.method];
      return byPriority === 0 ? a.id.localeCompare(b.id) : byPriority;
    })
    .map(({ id, method, contactKind, channel }) => ({
      id,
      method,
      contactKind,
      channel,
    }));
}

// OTP channels collapse to one `otp`, which is why the server never keys on it.
export function offeredMethodNames(
  options: OfferedOption[]
): TwoFactorMethod[] {
  return [...new Set(options.map((option) => option.method))];
}

/** `null` means "ask": only recovery material is left. */
export function defaultOption(options: OfferedOption[]): string | null {
  return options.find(AUTO_ROUTABLE)?.id ?? null;
}

// `passkey` is dropped: the reset flow has no WebAuthn ceremony to check it with.
export function recoveryOptions(
  state: EnrolmentState,
  contactKind: ContactKind
): OfferedOption[] {
  return offeredMethods(state, contactKind).filter(
    (option) => option.method !== 'passkey'
  );
}

// True means the reset is refused; the route back is the administrative reset.
export async function recoveryDefeatsTwoFactor(
  userId: EntityID,
  contactKind: ContactKind,
  executor: Executor = db
): Promise<boolean> {
  const state = await readEnrolmentState(userId, executor);
  // A user with no capability is already refused at sign-in; refusing recovery
  // too would leave no route at all.
  if (!state.enabled || offeredMethods(state).length === 0) return false;
  return recoveryOptions(state, contactKind).length === 0;
}

/**
 * Asked before the write. False for a user already at zero, so an operator can
 * still correct their contact.
 *
 * ⚠️ `contactKinds` is a set, asked once: asked per kind, changing both
 * contacts passes both checks and strands the user anyway.
 */
export async function contactChangeStrandsTwoFactor(
  userId: EntityID,
  contactKinds: readonly ContactKind[],
  executor: Executor = db
): Promise<boolean> {
  if (contactKinds.length === 0) return false;
  const state = await readEnrolmentState(userId, executor);
  if (!state.enabled || offeredMethods(state).length === 0) return false;

  const stranded: EnrolmentState = {
    ...state,
    capability: {
      ...state.capability,
      emailVerified: contactKinds.includes('email')
        ? false
        : state.capability.emailVerified,
      phoneVerified: contactKinds.includes('phone')
        ? false
        : state.capability.phoneVerified,
    },
  };
  return offeredMethods(stranded).length === 0;
}

// Against the offered set, not intent rows: an unusable row must not stand in
// for the last usable method. False for a user already at zero.
export function removalStrandsTwoFactor(
  state: EnrolmentState,
  method: TwoFactorMethod,
  contactKind: ContactKind | null
): boolean {
  if (offeredMethods(state).length === 0) return false;
  const remaining: EnrolmentState = {
    ...state,
    intent: state.intent.filter(
      (entry) => !matchesEnrolment(entry, method, contactKind)
    ),
  };
  return offeredMethods(remaining).length === 0;
}

/**
 * Idempotent. Failing to write it at enrolment silently disables the whole
 * feature for that user.
 */
async function recordMethodIntent(
  tx: Tx,
  params: {
    userId: EntityID;
    method: TwoFactorMethod;
    channel?: OtpChannel | null;
  }
): Promise<void> {
  const channel = params.channel ?? null;
  const values = {
    userId: params.userId,
    method: params.method,
    channel,
  };

  // ⚠️ Must match the two partial indexes in `db/schema.ts`: an `otp` row's
  // identity is its contact kind, so one `(user_id, method)` target would make
  // a second OTP contact replace the first.
  if (params.method === 'otp') {
    await tx
      .insert(twoFactorMethods)
      .values(values)
      .onConflictDoUpdate({
        target: [twoFactorMethods.userId, twoFactorMethods.contactKind],
        targetWhere: sql`method = 'otp'`,
        set: { channel },
      });
    return;
  }

  await tx
    .insert(twoFactorMethods)
    .values(values)
    .onConflictDoUpdate({
      target: [twoFactorMethods.userId, twoFactorMethods.method],
      targetWhere: sql`method <> 'otp'`,
      set: { channel },
    });
}

export async function recordEnabledMethod(
  tx: Tx,
  params: {
    userId: EntityID;
    method: TwoFactorMethod;
    channel?: OtpChannel | null;
  }
): Promise<void> {
  await recordMethodIntent(tx, params);
  await tx
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, params.userId));
}

export async function clearTwoFactorEnrolment(
  tx: Tx,
  userId: EntityID,
  options: { deletePasskeys: boolean }
): Promise<void> {
  await tx.delete(twoFactorMethods).where(eq(twoFactorMethods.userId, userId));
  await tx
    .delete(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId));
  if (options.deletePasskeys)
    await tx.delete(passkeys).where(eq(passkeys.userId, userId));
  await revokePendingTwoFactorCodes(tx, userId);
  await tx
    .update(users)
    .set({ twoFactorEnabled: false })
    .where(eq(users.id, userId));
}

/** Without `contactKind`, `otp` matches both of a user's OTP rows. */
export function enrolmentRows(
  userId: EntityID,
  method: TwoFactorMethod,
  contactKind: ContactKind | null | undefined
) {
  return and(
    eq(twoFactorMethods.userId, userId),
    eq(twoFactorMethods.method, method),
    ...(method === 'otp' && contactKind
      ? [eq(twoFactorMethods.contactKind, contactKind)]
      : [])
  );
}

/** The caller owns the last-method rule; this only performs the removal. */
export async function removeMethodIntent(
  tx: Tx,
  userId: EntityID,
  method: TwoFactorMethod,
  contactKind?: ContactKind | null
): Promise<number> {
  const removed = await tx
    .delete(twoFactorMethods)
    .where(enrolmentRows(userId, method, contactKind))
    .returning({ id: twoFactorMethods.id });
  if (method === 'otp')
    await revokePendingTwoFactorCodes(tx, userId, contactKind);
  return removed.length;
}
