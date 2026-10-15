import { fieldDocs } from './api/field-docs';
import {
  MEDIA_ERROR_CODES,
  OTP_PROOF_THROTTLE_CODE,
  REAUTH_REQUIRED_CODE,
} from './error-codes';
import { errorEnvelopeSchema } from './response-contract';

export const docs = [
  fieldDocs(errorEnvelopeSchema, {
    code: `Machine-readable error code when supplied; branch on it, never on \`message\`. Each operation lists the codes it answers per status. ${REAUTH_REQUIRED_CODE} requests a password or passkey re-authentication proof; ${OTP_PROOF_THROTTLE_CODE} is a proof-level OTP throttle, answered where the caller holds a session or a recovery grant; a media or upload refusal carries one of ${MEDIA_ERROR_CODES.join(', ')}.`,
    data: 'The ids that blocked a media refusal, for the codes that name them; null otherwise. A not-found never names an id.',
  }),
];
