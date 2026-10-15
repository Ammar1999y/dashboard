import type { MockProofKind, MockTwoFactor, MockUser } from '../store';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpPurpose,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_LOGIN_REQUIRED,
  twoFactorMsg,
} from '@app/shared/messages/auth';
import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';
import { CONTACT_LABEL, otpMsg } from '@app/shared/messages/otp';
import { passwordSchema } from '@app/shared/validation/rules';
import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { generateEntityId } from '@/utils/generate-id';

import { currentUser, proofs, reauth, session, twoFactor } from '../store';
import { now } from './db';
import { mayHoldSession } from './permissions';
import { requireReauthWindow } from './reauth';
import {
  emptyTwoFactor,
  enrolmentState,
  matchesEnrolment,
  MOCK_OTP_CODE,
} from './two-factor-model';

/**
 * The signed-in user, as the server's session middleware resolves them: a
 * session whose account is gone or deactivated is a 401.
 */
export function requireSessionUser(): MockUser {
  const user = currentUser();
  if (!user || !session.get() || !mayHoldSession(user))
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
  return user;
}

/** A served path answers like any other when its feature is off: 404. */
export function requireServed(served: boolean): void {
  if (!served) throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

/** The server's `methodNotFound`: one text for every way a method can be unavailable. */
export const methodNotFound = () =>
  new CustomError(twoFactorMsg.methodUnavailable, HTTP_STATUS.NOT_FOUND);

/** The method's own endpoints are served only when the deployment offers it. */
export function requireMethod(method: TwoFactorMethod): void {
  if (!isTwoFactorMethodEnabled(method)) throw methodNotFound();
}

/**
 * The server's `requireReauthPassword`: a password sent with the request is
 * checked (any that passes the schema is the account's, as at sign-in), and
 * with none the session's open window stands in, or the answer is
 * `REAUTH_REQUIRED`.
 */
export function requireReauthProof(password: unknown): void {
  // eslint-disable-next-line security/detect-possible-timing-attacks -- absence, not a secret
  if (password === undefined) return requireReauthWindow();
  if (!passwordSchema.safeParse(password).success)
    throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
}

/** What the user has set up; an account with nothing has no row until a write. */
export const twoFactorOf = (userId: EntityID): MockTwoFactor =>
  twoFactor.find(userId) ?? emptyTwoFactor(userId);

/** Writes `patch` over the user's state, creating it on the first write. */
export function writeTwoFactor(
  userId: EntityID,
  patch: Partial<Omit<MockTwoFactor, 'id'>>
): MockTwoFactor {
  const row = twoFactor.find(userId);
  const saved = row
    ? twoFactor.update(userId, patch)
    : twoFactor.insert({ ...emptyTwoFactor(userId), ...patch });
  if (!saved) throw new Error('two-factor state vanished during a write');
  return saved;
}

/** The server's `readEnrolmentState` for a user. */
export const enrolmentOf = (user: MockUser) =>
  enrolmentState(twoFactorOf(user.id), user);

const isLive = (expiresAt: string) => Date.parse(expiresAt) > Date.now();

export function findProof(userId: EntityID, kind: MockProofKind, key: string) {
  return proofs
    .all()
    .find(
      (proof) =>
        proof.userId === userId &&
        proof.kind === kind &&
        proof.key === key &&
        isLive(proof.expiresAt)
    );
}

/** Writes a proof, replacing the user's earlier one of the same kind and key. */
export function issueProof(
  userId: EntityID,
  kind: MockProofKind,
  key: string,
  {
    value = '',
    sends = 1,
    ttlSeconds,
  }: { value?: string; sends?: number; ttlSeconds: number }
) {
  const earlier = findProof(userId, kind, key);
  if (earlier) proofs.remove(earlier.id);
  return proofs.insert({
    id: generateEntityId(),
    userId,
    kind,
    key,
    value,
    sends,
    sentAt: now(),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
}

/** Single-use: reads the proof and removes it. */
export function takeProof(userId: EntityID, kind: MockProofKind, key: string) {
  const proof = findProof(userId, kind, key);
  if (proof) proofs.remove(proof.id);
  return proof;
}

/** The server's `markTwoFactorProven`: this session just proved a second factor. */
export function markTwoFactorProven(userId: EntityID, sessionId: string): void {
  issueProof(userId, 'two-factor-proven', sessionId, { ttlSeconds: 600 });
}

/** Closes the re-authentication window when it is this user's. */
export function dropReauthWindow(userId: EntityID): void {
  if (reauth.get()?.userId === userId) reauth.set(null);
}

/**
 * The server's `revokeTwoFactorState`: trust granted against a factor that may
 * be gone is a bypass, so the trusted devices go, and every short-lived proof
 * the user holds with them, the open window and a pending enrolment included.
 */
export function revokeTwoFactorState(userId: EntityID): void {
  if (twoFactorOf(userId).trustedDevices.length > 0)
    writeTwoFactor(userId, { trustedDevices: [] });
  for (const proof of proofs.all())
    if (proof.userId === userId) proofs.remove(proof.id);
  dropReauthWindow(userId);
}

/**
 * The server's `revokePendingProofs`: a credential rotation. The mocks hold one
 * session, which a rotation that keeps the current one leaves alone.
 */
export function rotateCredentials(
  userId: EntityID,
  trustedDevices: 'revoke' | 'keep' = 'revoke'
): void {
  if (trustedDevices === 'revoke') {
    revokeTwoFactorState(userId);
    return;
  }
  for (const proof of proofs.all())
    if (proof.userId === userId) proofs.remove(proof.id);
  dropReauthWindow(userId);
}

/** Every session of the user is revoked: here, the one session there is. */
export function endAllSessions(userId: EntityID): void {
  if (session.get()?.user.id === userId) session.set(null);
}

/** The server's `removeMethodIntent`; the caller owns the last-method rule. */
export function removeMethodIntent(
  userId: EntityID,
  method: TwoFactorMethod,
  contactKind?: ContactKind | null
): void {
  const row = twoFactorOf(userId);
  const methods = row.methods.filter(
    (entry) => !matchesEnrolment(entry, method, contactKind)
  );
  if (methods.length === row.methods.length) return;
  writeTwoFactor(userId, { methods });
  if (method === 'otp')
    for (const proof of proofs.all())
      if (
        proof.userId === userId &&
        proof.kind === 'otp' &&
        proof.key.startsWith('two_factor:')
      )
        proofs.remove(proof.id);
}

/**
 * The server's `recordEnabledMethod`: the method joins the enrolled set (an
 * `otp` one re-points its channel) and two-factor is on. It is never made the
 * default by being added.
 */
export function recordEnabledMethod(
  userId: EntityID,
  entry: Pick<MockTwoFactor['methods'][number], 'method' | 'channel'> & {
    contactKind: ContactKind | null;
  }
): void {
  const row = twoFactorOf(userId);
  const existing = row.methods.find((current) =>
    matchesEnrolment(current, entry.method, entry.contactKind)
  );
  writeTwoFactor(userId, {
    enabled: true,
    methods: existing
      ? row.methods.map((current) =>
          current === existing
            ? { ...current, channel: entry.channel }
            : current
        )
      : [...row.methods, { ...entry, isDefault: false }],
  });
}

/**
 * The server's `clearTwoFactorEnrolment`: every method, the secret and the
 * codes go and two-factor is off. Passkeys stay unless the caller deletes them
 * (an administrator's reset does; a user's own disable does not).
 */
export function clearTwoFactor(
  userId: EntityID,
  { deletePasskeys }: { deletePasskeys: boolean }
): void {
  const row = twoFactorOf(userId);
  writeTwoFactor(userId, {
    enabled: false,
    methods: [],
    totp: null,
    backupCodes: null,
    passkeys: deletePasskeys ? [] : row.passkeys,
  });
  for (const proof of proofs.all())
    if (proof.userId === userId && proof.kind === 'otp')
      proofs.remove(proof.id);
}

/** Seconds to wait before the next send to one destination, by sends so far. */
const RESEND_LADDER_S = [30, 60, 120, 240, 480] as const;
const MAX_SENDS = RESEND_LADDER_S.length;
const BLOCK_HOURS = 6;
const CODE_TTL_S = 600;

/** Seconds before the send after the one that left this proof; 0 once it may go. */
export const resendWait = ({
  sentAt,
  sends,
}: {
  sentAt: string;
  sends: number;
}) =>
  Math.max(
    0,
    Math.ceil(
      (Date.parse(sentAt) - Date.now()) / 1000 +
        RESEND_LADDER_S[Math.min(sends, MAX_SENDS) - 1]
    )
  );

/**
 * The server's `processOtpSend`, for a code to `destination`: the resend wait
 * doubles within a cycle (429 with `Retry-After` when asked early), and the
 * sixth send is refused. Answers the seconds to wait before the next one.
 */
export function sendCode(
  userId: EntityID,
  purpose: OtpPurpose,
  destination: string,
  contactKind: ContactKind
): number {
  const key = `${purpose}:${destination}`;
  const earlier = findProof(userId, 'otp', key);
  const sends = earlier?.sends ?? 0;
  if (earlier) {
    if (sends >= MAX_SENDS)
      throw new CustomError(
        otpMsg.sendBlocked(CONTACT_LABEL[contactKind], BLOCK_HOURS),
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    const wait = resendWait(earlier);
    if (wait > 0) {
      const refusal = new CustomError(
        otpMsg.resendWait(wait),
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
      refusal.responseHeaders = { 'Retry-After': String(wait) };
      throw refusal;
    }
  }
  issueProof(userId, 'otp', key, {
    value: MOCK_OTP_CODE,
    sends: sends + 1,
    ttlSeconds: CODE_TTL_S,
  });
  return RESEND_LADDER_S[Math.min(sends, MAX_SENDS - 1)];
}

const evaluatedGuesses = new WeakSet<object>();

/**
 * The server's `otpGuessWasEvaluated`: whether `verifyCode` refused a code that
 * was compared and lost. One that was never sent or has expired compared
 * nothing, and costs no attempt.
 */
export const otpGuessWasEvaluated = (error: unknown) =>
  typeof error === 'object' && error !== null && evaluatedGuesses.has(error);

/**
 * The server's `processOtpVerify`: no send is 404, an expired code and a wrong
 * one are 400, each with its own text. A match spends the code.
 */
export function verifyCode(
  userId: EntityID,
  purpose: OtpPurpose,
  destination: string,
  code: string
): void {
  const key = `${purpose}:${destination}`;
  const proof = proofs
    .all()
    .find(
      (entry) =>
        entry.userId === userId && entry.kind === 'otp' && entry.key === key
    );
  if (!proof) throw new CustomError(otpMsg.codeNotSent, HTTP_STATUS.NOT_FOUND);
  if (!isLive(proof.expiresAt))
    throw new CustomError(otpMsg.codeExpired, HTTP_STATUS.BAD_REQUEST);
  if (proof.value !== code) {
    const refusal = new CustomError(
      otpMsg.codeIncorrect,
      HTTP_STATUS.BAD_REQUEST
    );
    evaluatedGuesses.add(refusal);
    throw refusal;
  }
  proofs.remove(proof.id);
}
