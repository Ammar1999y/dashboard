import { schemaDocs } from '../api/field-docs';
import { passkeyGrantSchema, REAUTH_GRANT_MAX_AGE_S } from './two-factor';

export const docs = [
  schemaDocs(
    passkeyGrantSchema,
    `The token POST /two-factor/passkey/grant answered with. Single use, bound to this account, valid for ${REAUTH_GRANT_MAX_AGE_S / 60} minutes.`
  ),
];
