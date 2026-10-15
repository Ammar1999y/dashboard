import { fieldDocs } from '../api/field-docs';
import { OTP_BASE_RESEND_DELAY_S } from '../validation/constants';
import {
  anonymousOtpSentSchema,
  ladderOtpSentSchema,
  reauthGrantSchema,
  recoveryResultSchema,
} from './auth';

const [, secondFactorRequired] = recoveryResultSchema.options;

export const docs = [
  fieldDocs(reauthGrantSchema, {
    expiresIn:
      'Seconds the window lasts. It is bound to THIS session — there is no token to send back, the same cookie carries it.',
  }),
  fieldDocs(anonymousOtpSentSchema, {
    nextAllowedIn: `Seconds before another code may be requested: always ${OTP_BASE_RESEND_DELAY_S}, for a real and an unknown identifier alike.`,
  }),
  fieldDocs(ladderOtpSentSchema, {
    nextAllowedIn:
      'Seconds before another code may be requested; the delay grows with each code sent in the current cycle.',
  }),
  fieldDocs(secondFactorRequired, {
    grant:
      'The recovery grant: post it with one of `options` to `/forgot-password/second-factor/send` and `/forgot-password/complete`. It proves the recovery contact and nothing else.',
    options: 'The second factors that can finish this reset.',
    defaultMethod:
      'The option to offer first; `null` means ask: only recovery material is left.',
  }),
];
