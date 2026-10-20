import {
  INVALID_RESPONSE_CODE,
  MEDIA_ERROR_CODES,
  OTP_PROOF_THROTTLE_CODE,
  REAUTH_REQUIRED_CODE,
} from '../error-codes';
import { fieldDocs } from './field-docs';
import { authProblemSchema, problemSchema } from './wire';

export const docs = [
  fieldDocs(problemSchema, {
    type: 'Always `about:blank`: the status and `code` identify the problem.',
    title:
      'The English reason phrase of `status` (RFC 9110). Never shown to users.',
    status: 'The HTTP status code of this answer.',
    detail: 'The localised message to show the user.',
    code: `Machine-readable error code when supplied; branch on it, never on \`detail\`. Each operation lists the codes it answers per status. ${REAUTH_REQUIRED_CODE} requests a password or passkey re-authentication proof; ${OTP_PROOF_THROTTLE_CODE} is a proof-level OTP throttle, answered where the caller holds a session or a recovery grant; ${INVALID_RESPONSE_CODE} is a success whose body failed its own contract, so a write has committed and must not be retried; a media or upload refusal carries one of ${MEDIA_ERROR_CODES.join(', ')}.`,
    data: 'The ids that blocked a media refusal, for the codes that name them; absent otherwise. A not-found never names an id.',
  }),
  fieldDocs(authProblemSchema, {
    message:
      'The same text as `detail`, for Better Auth’s client, which reads `message`.',
  }),
];
