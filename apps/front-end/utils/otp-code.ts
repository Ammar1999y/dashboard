import { normalizeArabicDigits } from '@app/shared/utils';
import { OTP_CODE_LENGTH } from '@app/shared/validation/constants';

/**
 * What a code field keeps of what was typed or pasted: Latin digits only, the
 * length of a code. An Arabic keyboard types Arabic-Indic digits, and a code
 * copied out of a message brings spaces or a dash with it.
 */
export const cleanOtpInput = (value: string): string =>
  normalizeArabicDigits(value).replaceAll(/\D/g, '').slice(0, OTP_CODE_LENGTH);
