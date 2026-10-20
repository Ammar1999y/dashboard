import type { SignInResult, TwoFactorChallenge } from './schemas';
import type { ContactKind } from '@app/shared/validation/enums';

import { toast } from 'sonner';
import { trustCurrentDevice } from '@app/shared/api/better-auth';
import { CustomError } from '@app/shared/error-class';
import {
  EMAIL_NOT_VERIFIED_CODE,
  PHONE_NOT_VERIFIED_CODE,
  TWO_FACTOR_UNAVAILABLE_CODE,
} from '@app/shared/error-codes';
import { MSG_LOGIN_SUCCESS } from '@app/shared/messages/common';
import { MSG_TRUST_DEVICE_FAILED } from '@/constants/messages';
import { api } from '@/lib/api/client';
import { hasErrorCode } from '@/lib/api/fetch';

/**
 * What follows a second factor the server accepted: the session exists, and
 * remembering this device is a separate request that needs the proof that
 * request just left. A refusal to remember it does not undo the sign-in, so it
 * is reported by itself.
 */
export async function finishSignIn(trustDevice: boolean) {
  toast.success(MSG_LOGIN_SUCCESS);
  if (!trustDevice) return;
  try {
    await api(trustCurrentDevice);
  } catch (error) {
    // The server's text for a failed save talks about sending a code.
    console.error(error);
    toast.error(MSG_TRUST_DEVICE_FAILED);
  }
}

/**
 * The answer of a first factor that may open a session or a challenge. A
 * session needs nothing more here: the page leaves once it appears.
 */
export function routeSignInResult(
  result: SignInResult,
  onChallenge: (challenge: TwoFactorChallenge) => void
) {
  if ('twoFactorRedirect' in result) onChallenge(result);
  else toast.success(MSG_LOGIN_SUCCESS);
}

/**
 * The refusal of a sign-in whose account holds a second factor it can no
 * longer complete: its message, or `null` for any other failure.
 */
export function twoFactorUnavailableMessage(error: unknown) {
  return error instanceof CustomError &&
    error.code === TWO_FACTOR_UNAVAILABLE_CODE
    ? error.message
    : null;
}

/** Which contact a sign-in refused for being unverified, if it was refused for that. */
export function unverifiedContactKind(error: unknown): ContactKind | null {
  if (hasErrorCode(error, EMAIL_NOT_VERIFIED_CODE)) return 'email';
  if (hasErrorCode(error, PHONE_NOT_VERIFIED_CODE)) return 'phone';
  return null;
}
