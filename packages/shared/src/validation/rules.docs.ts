import { schemaDocs } from '../api/field-docs';
import { PHONE_ENABLED } from '../config';
import { EMAIL_MAX, PASSWORD_MAX, PASSWORD_MIN } from './constants';
import {
  EMAIL_PROVIDER_DOMAINS,
  emailSchema,
  idStringSchema,
  optionalPhoneSchema,
  passwordSchema,
  phoneSchema,
  reauthPasswordSchema,
  SLUG_MAX,
  slugSchema,
} from './rules';

/**
 * What the two sanitizers do, for the OpenAPI document.
 *
 * `z.toJSONSchema` sees neither preprocess, so every `min`/`max` on a sanitized
 * leaf describes the string AFTER stripping and trimming while the document
 * presents it as a rule about the raw input. Both sanitizers only ever SHORTEN,
 * which decides what each published keyword is worth:
 *
 *  - `minLength` cannot refuse a valid request — a raw value shorter than the
 *    floor cannot grow past it — so it stays. It is merely lax: `"a "` against
 *    `minLength: 2` passes the document and is refused by the server, which
 *    keeps one character.
 *  - `maxLength` can, and so it goes. A hundred and fifty characters plus two
 *    spaces is trimmed to 150 and ACCEPTED, while a validator measures 152
 *    against `maxLength: 150` and refuses a request the server would have
 *    answered — and the amount a strippable character or a space can shrink a
 *    value by is unbounded, so no finite ceiling is true of raw input. The
 *    number travels as prose instead (`strictTextMaximum`); the request is still
 *    bounded, by the body ceiling in `app.ts`.
 *
 * The stripped class cannot become a `pattern` either — a JSON Schema pattern
 * has no `u` flag, so `\p{L}` is inexpressible. Where a leaf's rule CAN be
 * written against raw input it is, and then the bound rides in the pattern: see
 * `otpCodeSchema` and the media names.
 */
export const STRICT_TEXT_DESCRIPTION =
  'Characters outside letters, marks, digits, spaces and `. , ! ? : / \\ ; - + = ( ) [ ] \' " ؟ ، ؛ @ # _ & %` are removed and the value is trimmed before the length rules apply, so it may be sent as typed';

/** `sanitizeStrictSingleLine` additionally folds every whitespace run to one space. */
export const STRICT_SINGLE_LINE_DESCRIPTION = `${STRICT_TEXT_DESCRIPTION}. Line breaks and repeated spaces are collapsed to a single space.`;

/**
 * The ceiling, as prose, for a leaf whose `maxLength` cannot be published — and
 * the marker that the omission is a decision rather than an oversight.
 */
export const strictTextMaximum = (max: number) =>
  `After that it must be at most ${max} characters.`;

/**
 * The whole rule as prose, because the normalisation leaves no published
 * keyword true of raw input — and in the runtime's own terms rather than a
 * paraphrase. Rounding any clause to "a letter" or "a character" describes a
 * schema that refuses passwords this one accepts.
 */
const PASSWORD_DESCRIPTION = `Unicode-normalised (NFKC) before validation, so it may be sent as typed and every rule below measures the normalised form: ${PASSWORD_MIN} to ${PASSWORD_MAX} characters counted as Unicode code points, containing at least one ASCII lowercase letter (a-z), one ASCII uppercase letter (A-Z), one ASCII digit (0-9), and at least one character outside those three ranges. A character that NFKC folds into one of those ranges counts as it. The line terminators U+000A, U+000D, U+2028 and U+2029 are rejected anywhere in the value.`;

const OPTIONAL_PHONE =
  'Saudi mobile number, as accepted by the required form. `null` or an empty string clears it; omitting the key on an update leaves it unchanged.';

export const docs = [
  schemaDocs(
    idStringSchema,
    'Surrounding whitespace is trimmed and the value lowercased before the pattern applies, so it may be sent as received.'
  ),
  schemaDocs(
    emailSchema.out,
    `Email address. Whitespace is collapsed and trimmed and the address is lowercased before validation, so it may be sent as typed; after that it must be at most ${EMAIL_MAX} characters. Only these providers are accepted: ${EMAIL_PROVIDER_DOMAINS.join(', ')}.`
  ),
  schemaDocs(passwordSchema.out, PASSWORD_DESCRIPTION),
  // The converter emits only the wrapper's description, so the window note
  // alone would drop every password rule.
  schemaDocs(
    reauthPasswordSchema,
    `${PASSWORD_DESCRIPTION} May be omitted while this session has an open password/passkey reauthentication window. Otherwise omission returns 401 REAUTH_REQUIRED.`
  ),
  schemaDocs(
    phoneSchema.out,
    'Saudi mobile number. Strings may contain separators or Arabic digits; numbers are also accepted. Normalized output is 9665XXXXXXXX.'
  ),
  schemaDocs(
    optionalPhoneSchema,
    PHONE_ENABLED
      ? OPTIONAL_PHONE
      : `${OPTIONAL_PHONE} Phone input is disabled; omit this field or clear it.`
  ),
  schemaDocs(
    slugSchema.out,
    `Lowercased, trimmed, and whitespace and repeated hyphens collapsed to single hyphens before validation, so it may be sent as typed. ${strictTextMaximum(SLUG_MAX)}`
  ),
];
