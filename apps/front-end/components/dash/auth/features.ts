import type { ContactKind } from '@app/shared/validation/enums';

import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import {
  EMAIL_OTP_AVAILABLE,
  OTP_ENABLED,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';

/** The gates the server's own routes use: a disabled route answers 404, so it is not offered. */
export const PASSWORDLESS_AVAILABLE = OTP_ENABLED && PASSWORDLESS_ENABLED;

/** Whether a code can reach this kind of contact, which verifying it takes. */
export const canVerifyContact = (kind: ContactKind) =>
  OTP_ENABLED && (kind === 'email' ? EMAIL_OTP_AVAILABLE : PHONE_OTP_AVAILABLE);
