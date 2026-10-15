import type { HandlerError } from '@/lib/http/contract';

import * as z from 'zod';

import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { isChannelEnabled, sendOtpSchema } from '@app/shared/validation/otp';

import { refusalOf } from '@/lib/http/binding';
import { handleApiError } from '@/lib/http/response';
import {
  collapseAnonymousVerifyError,
  invalidOrExpiredCode,
} from '@/lib/otp/throttle';

/** A per-field message would say which branch of the channel union matched. */
export const FIXED_BODY_REFUSAL = {
  body: { status: HTTP_STATUS.UNPROCESSABLE, message: otpMsg.invalidInput },
} as const;

/**
 * A verify answers every refusal it does not surface as its wrong-or-expired
 * code (`collapsedVerifyError`); the gate reads the body, so its 400 and 413
 * need this to read the same.
 */
export const COLLAPSED_BODY_REFUSALS = {
  ...FIXED_BODY_REFUSAL,
  unreadableBody: refusalOf(invalidOrExpiredCode()),
};

/**
 * The send body as the document publishes it: only the channels this
 * deployment enables. Validation keeps every branch, so a disabled channel
 * keeps its own refusal.
 */
export const PUBLISHED_SEND_BODY = z.xor(
  sendOtpSchema.options.filter((option) =>
    isChannelEnabled(option.shape.channel.value)
  )
);

/**
 * A verify's account-dependent refusals, answered as one wrong-or-expired
 * code; everything else is left to the binding's own failure.
 */
export function collapsedVerifyError(alsoSurface: readonly number[] = []) {
  return (error: unknown): HandlerError | undefined => {
    const collapsed = collapseAnonymousVerifyError(
      error,
      otpMsg.invalidOrExpired,
      alsoSurface
    );
    return collapsed === error ? undefined : handleApiError(collapsed);
  };
}
