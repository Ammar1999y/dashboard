import type { JsonSchema } from './json-schema';
import type { ResponseComponentName } from './success-schemas';

import {
  DASHBOARD_PAGE_NAMES,
  PERMISSION_ACTION_NAMES,
} from '@app/shared/permissions/constants';
import { UUID_V7_PATTERN } from '@app/shared/utils';
import {
  CAPTCHA_HEADER,
  CAPTCHA_TOKEN_MAX_LENGTH,
} from '@app/shared/validation/auth';

export const UUID_SCHEMA: JsonSchema = {
  type: 'string',
  format: 'uuid',
  pattern: UUID_V7_PATTERN,
};
export const NULL_SCHEMA: JsonSchema = { type: 'null' };
export const NULLABLE_STRING_SCHEMA: JsonSchema = { type: ['string', 'null'] };

const ERROR_ENVELOPE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    success: { const: false },
    message: { type: 'string' },
    code: {
      type: 'string',
      description:
        'Machine-readable error code when supplied. REAUTH_REQUIRED requests a password/passkey reauthentication proof. otp_proof_throttle identifies a proof-level OTP throttle at an authenticated boundary.',
    },
    data: NULL_SCHEMA,
  },
  required: ['success', 'message', 'data'],
  additionalProperties: false,
};

const COMPLETE_ACTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    PERMISSION_ACTION_NAMES.map((action) => [action, { type: 'boolean' }])
  ),
  additionalProperties: false,
  required: [...PERMISSION_ACTION_NAMES],
};
/** The page-keyed shape session metadata carries, not the role's row list. */
export const USER_PERMISSION_MATRIX_SCHEMA: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    DASHBOARD_PAGE_NAMES.map((page) => [page, COMPLETE_ACTIONS_SCHEMA])
  ),
  additionalProperties: false,
};

/**
 * The hand-written schemas published once under `components.schemas`; the
 * response components are converted in `success-schemas.ts`.
 *
 * `satisfies` rather than an annotation, so `keyof` stays the literal names and
 * `componentRef` refuses a name nothing defines.
 */
export const COMPONENT_SCHEMAS = {
  ErrorEnvelope: ERROR_ENVELOPE_SCHEMA,
} satisfies Record<string, JsonSchema>;

export function componentRef(
  name: keyof typeof COMPONENT_SCHEMAS | ResponseComponentName
): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

export const CAPTCHA_HEADER_PARAMETER: JsonSchema = {
  name: CAPTCHA_HEADER,
  in: 'header',
  required: true,
  description: 'Cloudflare Turnstile response token.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: CAPTCHA_TOKEN_MAX_LENGTH,
  },
};
