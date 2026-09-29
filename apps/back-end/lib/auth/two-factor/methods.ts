/**
 * A user's second factors: what they turned on (intent), what they could
 * complete (capability), and what a challenge therefore offers.
 */
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

import { CONTACT_KINDS, contactKindOf } from '@app/shared/validation/enums';
import {
  ENABLED_TWO_FACTOR_METHODS,
  isTwoFactorOtpChannelEnabled,
} from '@app/shared/validation/two-factor';

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

/**
 * What the user is offered, as a STABLE identity rather than a method name: a
 * name cannot tell an OTP to the email from an OTP to the phone, and those are
 * different possessions. Everything downstream (the challenge response, the
 * default, send, verify, removal, the companion record) keys on `id`.
 */
export interface OfferedOption {
  id: string;
  method: TwoFactorMethod;
  contactKind: ContactKind | null;
  /** Delivery preference for an `otp` option; never part of its identity. */
  channel: OtpChannel | null;
}

export function optionId(
  method: TwoFactorMethod,
  contactKind: ContactKind | null
): string {
  return method === 'otp' ? `otp:${contactKind ?? 'unknown'}` : method;
}

export function asContactKind(value: unknown): ContactKind | null {
  return CONTACT_KINDS.find((kind) => kind === value) ?? null;
}

/** Whether `entry` is the enrolment `method` names; `otp` is one per contact kind. */
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

/**
 * System priority. `backup_code` is last AND excluded from auto-routing, so a
 * routine login never spends recovery material.
 */
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
    // Deterministic, because the response order is the order a client offers
    // and a default the database reorders between requests is not a default.
    .orderBy(twoFactorMethods.method, twoFactorMethods.contactKind);
  return rows.map((row) => ({
    method: row.method,
    channel: row.channel,
    contactKind: asContactKind(row.contactKind),
    isDefault: row.isDefault,
  }));
}

/**
 * ⚠️ A caller inside a transaction must pass it as `executor`: reading through
 * the module-level `db` from there acquires a second pooled connection, and the
 * pool deadlocks once every connection is held by a transaction waiting for
 * another.
 */
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
      // ⚠️ Three conditions, and dropping any one advertises recovery material
      // the user does not have: the acknowledgement must belong to the CURRENT
      // set (regeneration replaces every code), and the set must still hold an
      // unspent code. Both ids are NULL on a row that has never generated a
      // set, where equality alone would read as "acknowledged".
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
 * The user's intent, intersected with capability and with the deployment's
 * enabled methods and OTP channels.
 *
 * `excludeContactKind` is the possession the first factor already proved — a
 * passwordless sign-in passes the contact kind its code reached, and an OTP
 * second factor aimed at the same kind proves nothing. Password sign-in passes
 * nothing: a knowledge factor leaves every contact a real second factor.
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
      // The user's own default first, then system priority, then a stable tie
      // break on the identity itself so the order cannot move between requests.
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

/**
 * The distinct method NAMES of an offered set, for the published
 * `twoFactorMethods` field. Two OTP channels collapse to one `otp` here, which
 * is why the server never keys on it.
 */
export function offeredMethodNames(
  options: OfferedOption[]
): TwoFactorMethod[] {
  return [...new Set(options.map((option) => option.method))];
}

/**
 * Where the challenge routes with no choice from the user. `null` means "ask":
 * the only thing left is recovery material, which is never auto-routed.
 */
export function defaultOption(options: OfferedOption[]): string | null {
  return options.find(AUTO_ROUTABLE)?.id ?? null;
}

/**
 * The options a password reset may ask for as a second factor. Two
 * subtractions from the offered set:
 *
 *  - the CONTACT the recovery code arrived on, because a second code to the same
 *    mailbox proves nothing the first did not — a property of the
 *    authentication chain rather than of the enrolled set;
 *  - `passkey`, because this flow has no request context to run a WebAuthn
 *    ceremony in, and an option that cannot be checked would either hang the
 *    reset or let it run unproven.
 */
export function recoveryOptions(
  state: EnrolmentState,
  contactKind: ContactKind
): OfferedOption[] {
  return offeredMethods(state, contactKind).filter(
    (option) => option.method !== 'passkey'
  );
}

/**
 * Would resetting the password through `contactKind` leave the reset nothing
 * to ask for as a second factor?
 *
 * Refused rather than gated when nothing is left: the account keeps its second
 * factor and the route back is the administrative reset. When something IS
 * left, `lib/auth/recovery/grant.ts` carries the reset to a second request that
 * proves it first.
 */
export async function recoveryDefeatsTwoFactor(
  userId: EntityID,
  contactKind: ContactKind,
  executor: Executor = db
): Promise<boolean> {
  const state = await readEnrolmentState(userId, executor);
  // Capability, not intent: a user whose capability is gone is already refused
  // at sign-in, so refusing recovery too would leave them no route at all.
  if (!state.enabled || offeredMethods(state).length === 0) return false;
  return recoveryOptions(state, contactKind).length === 0;
}

/**
 * Would changing these contacts leave this user with no factor they can
 * complete?
 *
 * `offeredMethods` reads the user row's verified flags, so a write that clears
 * one — or moves the address an OTP enrolment points at — takes that option out
 * of the offered set. Asked BEFORE the write, and only true when the change is
 * what removes the last usable factor: a user already at zero is refused at
 * sign-in regardless, and blocking the edit would leave an operator unable to
 * correct their contact at all.
 *
 * ⚠️ `contactKinds` is a SET, asked ONCE. Asked per kind against unmodified
 * state, a request changing both contacts of a user with two OTP enrolments
 * passes both checks and strands the user anyway.
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

/**
 * Would removing this enrolment leave the user with no factor a challenge would
 * offer?
 *
 * Asked against the OFFERED set, not the intent rows: a row whose channel was
 * dropped, whose contact is unverified or whose backup set is spent is still a
 * row, and must not stand in for the last usable method. Only true when the
 * removal is what empties the set: a user already at zero is refused at sign-in
 * regardless, and blocking their cleanup would leave them no better off.
 */
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
 * Idempotent: the call site is "a verification succeeded", true both at
 * enrolment and at every later sign-in. Failing to write it at enrolment
 * silently disables the whole feature for that user.
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

  // ⚠️ Two conflict targets, matching the two partial indexes in `db/schema.ts`
  // exactly. An `otp` row's identity is its CONTACT KIND, so re-enrolling
  // `sms` over `whatsapp` updates the delivery preference of the phone
  // enrolment while an `email` enrolment is a separate row. Every other method
  // is one row per user; a single `(user_id, method)` target would make a
  // second OTP channel replace the first.
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

/** The intent row, and the user's `twoFactorEnabled` flag with it. */
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
  await tx
    .update(users)
    .set({ twoFactorEnabled: false })
    .where(eq(users.id, userId));
}

/** The intent row(s) `method` names; `contactKind` narrows `otp` to ONE of a user's two. */
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
  return removed.length;
}
