import { fieldDocs, schemaDocs } from '../api/field-docs';
import { OTP_CODE_LENGTH } from './constants';
import {
  otpCodeSchema,
  recoveryCompleteSchema,
  recoverySecondFactorSendSchema,
} from './otp';
import { STRICT_SINGLE_LINE_DESCRIPTION } from './rules.docs';

export const docs = [
  schemaDocs(otpCodeSchema.out, STRICT_SINGLE_LINE_DESCRIPTION),
  fieldDocs(recoverySecondFactorSendSchema, {
    grant: 'The recovery grant `/forgot-password/reset` answered with.',
    option: 'The id of one of the options that answer listed.',
  }),
  fieldDocs(recoveryCompleteSchema, {
    code: `The code for the chosen option: ${OTP_CODE_LENGTH} digits, or a backup code shaped \`xxxxx-xxxxx\`.`,
  }),
];
