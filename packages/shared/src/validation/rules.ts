import * as z from 'zod';

import { MSG_INVALID_INPUT } from '../messages/common';
import {
  idRequired,
  ISSUE_FALLBACKS,
  MSG_COLOR_INVALID,
  MSG_EMAIL_INVALID,
  MSG_EMAIL_PROVIDER_NOT_ACCEPTED,
  MSG_EMAIL_TOO_LONG,
  MSG_PASSWORD_INVALID,
  MSG_PASSWORD_REQUIRED,
  MSG_PASSWORD_TOO_LONG,
  MSG_PASSWORD_TOO_SHORT,
  MSG_PHONE_INVALID,
  MSG_PHONE_REQUIRED,
  MSG_SLUG_DIGITS_ONLY,
  MSG_SLUG_INVALID_CHARACTERS,
  MSG_SLUG_TOO_LONG,
  MSG_UNRECOGNIZED_KEYS,
} from '../messages/validation';
import {
  normalizeArabicDigits,
  UUID_V7_FRAGMENT,
  UUID_V7_REGEX,
  validID,
} from '../utils';
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PHONE_NUMBER_MAX,
} from './constants';

/** What `STRICT_TEXT_DESCRIPTION` tells the document; keep the two in step. */
const STRIPPED_CHARACTERS =
  /[^\p{L}\p{M}\p{N}\p{Zs}\n\.,!?:/\\;\-+=\(\)\[\]''"؟،؛@#_&%]/gu;

/**
 * ⚠️ The parameter annotation on every preprocess callback in this package is
 * the WIRE contract, not a runtime guarantee, and it is load-bearing:
 * `z.preprocess` infers its input type from this parameter alone, so an
 * `unknown` here makes `RequestBody<…>` (`contract.ts`) `unknown` on the field
 * and the exported client type stops rejecting anything at all. The `typeof`
 * guard below is therefore NOT dead — Zod hands these callbacks whatever the
 * JSON carried — and both have to stay.
 */
export const sanitizeStrict = (v: string) =>
  typeof v === 'string' ? v.replaceAll(STRIPPED_CHARACTERS, '').trim() : v;

export const sanitizeStrictSingleLine = (v: string) =>
  typeof v === 'string'
    ? v.replaceAll(STRIPPED_CHARACTERS, '').replaceAll(/\s+/g, ' ').trim()
    : v;

/**
 * What the two sanitizers above do, for the OpenAPI document.
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
 * Does this message come from this project, or from Zod?
 *
 * Every message this codebase writes is Arabic, and every Zod default is ASCII,
 * so the script is the discriminator, with no per-schema bookkeeping.
 */
const ARABIC_LETTER = /\p{Script=Arabic}/u;

/**
 * Unknown keys are attacker-controlled JSON key names, so a reflected key (and
 * a path, bounded the same way) is truncated and counted; every other
 * client-facing message is a server-owned constant.
 */
const MAX_REFLECTED_KEYS = 5;
const MAX_REFLECTED_KEY_LENGTH = 40;

function reflectPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  const named = path
    .slice(0, MAX_REFLECTED_KEYS)
    .map((key) => String(key).slice(0, MAX_REFLECTED_KEY_LENGTH))
    .join('.');
  return ` (${named})`;
}

/**
 * The server's message for an issue no schema node authored: the code's entry
 * in `ISSUE_FALLBACKS` with the field path, which Zod's own defaults do not
 * name, or the offending keys of a `.strict()` rejection. Zod's built-in
 * unknown-key message is English and would be the only non-Arabic string a
 * client ever sees; naming the keys is also what turns a silently-stripped typo
 * into an actionable 422.
 *
 * Takes the raw issue too, so a client can install it as Zod's `customError`
 * and word every unauthored issue exactly as this server does.
 */
export function localizedIssueMessage(
  issue: z.core.$ZodIssue | z.core.$ZodRawIssue
): string {
  if (issue.code === 'unrecognized_keys')
    return unrecognizedKeysMessage(issue.keys);
  return `${ISSUE_FALLBACKS[issue.code] ?? MSG_INVALID_INPUT}${reflectPath(issue.path ?? [])}`;
}

/** First-issue message for a failed `safeParse`. A message the schema authored wins. */
export function zodIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return MSG_INVALID_INPUT;
  if (issue.code !== 'unrecognized_keys' && ARABIC_LETTER.test(issue.message))
    return issue.message;
  return localizedIssueMessage(issue);
}

function unrecognizedKeysMessage(keys: readonly PropertyKey[]): string {
  const named = keys
    .slice(0, MAX_REFLECTED_KEYS)
    .map((key) => String(key).slice(0, MAX_REFLECTED_KEY_LENGTH));
  const hidden = keys.length - named.length;
  return MSG_UNRECOGNIZED_KEYS(named, hidden);
}

export const ID_DESCRIPTION =
  'Surrounding whitespace is trimmed and the value lowercased before the pattern applies, so it may be sent as received.';

/**
 * The published rule for the RAW value, which is not `UUID_V7_PATTERN`: the
 * preprocess trims, so the anchored form refuses a padded id the server accepts.
 * Case needs nothing — the fragment already admits both.
 */
export const ID_INPUT_PATTERN = String.raw`^\s*${UUID_V7_FRAGMENT}\s*$`;

/** The id rule after `validID` has normalised the value, for wrappers that add to it. */
export const idStringSchema = z
  .string(idRequired)
  .regex(UUID_V7_REGEX, idRequired)
  .meta({ pattern: ID_INPUT_PATTERN, description: ID_DESCRIPTION });

export const idSchema = z.preprocess(
  // The rejected sentinel has to be of the id's own type, or a malformed id of
  // the right type is answered as `invalid_type` instead of as a bad format.
  (v: string) => validID(v) || '',
  idStringSchema
);

/** `null` means "none"; where a key may be omitted, a missing one means "unchanged". */
export const nullableIdSchema = z.preprocess(
  (value: string | null) => (value == null ? null : validID(value) || 0),
  idStringSchema.nullable()
);

/**
 * The consumer providers this deployment accepts, as data.
 *
 * As data because the runtime check below and the pattern the document
 * publishes for the typed address need the SAME list. The allowlist is a
 * deliberate interim policy: custom and business domains stay refused until the
 * domain policy is decided.
 */
const EMAIL_PROVIDER_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
] as const;

/* eslint-disable-next-line security/detect-non-literal-regexp -- built from the
   module-local literal tuple above, which no caller can influence */
const EMAIL_ALLOWLIST_PATTERN = new RegExp(
  `^[A-Za-z0-9._%+-]+@(?:${EMAIL_PROVIDER_DOMAINS.map((domain) =>
    domain.replaceAll('.', String.raw`\.`)
  ).join('|')})$`
);

/**
 * One literal, spelled so a flagless pattern matches it case-insensitively.
 *
 * JSON Schema patterns are ECMA-262 with no flags, so `i` is not available and
 * the insensitivity has to live in the character classes.
 */
function caseInsensitiveLiteral(literal: string): string {
  return [...literal]
    .map((character) => {
      const lower = character.toLowerCase();
      const upper = character.toUpperCase();
      if (lower !== upper) return `[${lower}${upper}]`;
      return /[a-zA-Z0-9]/.test(character) ? character : `\\${character}`;
    })
    .join('');
}

/**
 * The published rule for the RAW address, which is none of the three constraints
 * the converter emits from the schema below.
 *
 * The preprocess collapses whitespace, trims and lowercases, so the allowlist
 * pattern (case-sensitive) refuses `User@Gmail.com` and the anchors refuse
 * ` user@gmail.com ` — both of which the server accepts. The length bound is the
 * same problem in the other direction, and `.max()` cannot describe raw input at
 * all once unbounded padding is legal — so the bound moves INTO the pattern as
 * the longest local part any allowed domain leaves room for, and `maxLength` is
 * dropped. That is exact in the direction that matters: every address the server
 * accepts matches, and the only thing left unbounded is surrounding whitespace.
 *
 * Generated from `EMAIL_PROVIDER_DOMAINS` rather than typed out, so the document
 * cannot fall behind the allowlist.
 */
const EMAIL_LOCAL_MAX =
  EMAIL_MAX - 1 - Math.min(...EMAIL_PROVIDER_DOMAINS.map((d) => d.length));

const EMAIL_INPUT_PATTERN = String.raw`^\s*[A-Za-z0-9._%+-]{1,${EMAIL_LOCAL_MAX}}@(?:${EMAIL_PROVIDER_DOMAINS.map(
  (domain) => caseInsensitiveLiteral(domain)
).join('|')})\s*$`;

export const emailSchema = z.preprocess(
  (v: string) =>
    typeof v === 'string' ? v.replaceAll(/\s+/g, ' ').trim().toLowerCase() : '',
  z
    .email(MSG_EMAIL_INVALID)
    .max(EMAIL_MAX, MSG_EMAIL_TOO_LONG)
    .regex(EMAIL_ALLOWLIST_PATTERN, MSG_EMAIL_PROVIDER_NOT_ACCEPTED)
    // The document's whole request rule for this field: `pattern` REPLACES the
    // `allOf` the two checks above convert to. See `EMAIL_INPUT_PATTERN`.
    //
    // ⚠️ No `format: 'email'`, deliberately, and it is not an oversight that it
    // is absent where the RESPONSE schemas carry it. `format` asserts under a
    // validator configured to assert it (Ajv does by default), and
    // ` user@gmail.com ` is not an email address by that rule — while this
    // schema trims and accepts it. A response carries the stored value, which is
    // already normalised, so there it is true and stays.
    .meta({
      maxLength: undefined,
      allOf: undefined,
      pattern: EMAIL_INPUT_PATTERN,
      description:
        `Email address. Whitespace is collapsed and trimmed and the address is lowercased before validation, so it may be sent as typed; after that it must be at most ${EMAIL_MAX} characters. Only these providers are accepted: ` +
        EMAIL_PROVIDER_DOMAINS.join(', ') +
        '.',
    })
);

/**
 * Canonical password form. `hashPassword` / `verifyPassword` NFKC-normalize
 * before hashing, so every other check has to see the SAME string: policy
 * validation, old-vs-new comparison and the HIBP breach lookup all run on the
 * schema output. Normalizing only at the storage layer let a
 * compatibility-equivalent input (e.g. U+FB01 "ﬁ" → "fi") pass a breach check
 * and then normalize into a breached credential. NFKC is idempotent, so the
 * storage-layer normalization stays as defense in depth for non-schema callers.
 */
export const normalizePasswordInput = (v: string) =>
  typeof v === 'string' ? v.normalize('NFKC') : v;

/**
 * The whole rule as prose, because the normalisation below leaves no published
 * keyword true of raw input — and in the runtime's own terms rather than a
 * paraphrase. Rounding any clause to "a letter" or "a character" describes a
 * schema that refuses passwords this one accepts.
 */
const PASSWORD_DESCRIPTION = `Unicode-normalised (NFKC) before validation, so it may be sent as typed and every rule below measures the normalised form: ${PASSWORD_MIN} to ${PASSWORD_MAX} characters counted as Unicode code points, containing at least one ASCII lowercase letter (a-z), one ASCII uppercase letter (A-Z), one ASCII digit (0-9), and at least one character outside those three ranges. A character that NFKC folds into one of those ranges counts as it. The line terminators U+000A, U+000D, U+2028 and U+2029 are rejected anywhere in the value.`;

/** Every rule `passwordSchema` applies, in the order a client lists them. */
export const PASSWORD_RULES = [
  'length',
  'digit',
  'lowercase',
  'uppercase',
  'other',
  'singleLine',
] as const;

export type PasswordRule = (typeof PASSWORD_RULES)[number];

const PASSWORD_CHARACTER_CLASSES: Record<
  Exclude<PasswordRule, 'length' | 'singleLine'>,
  RegExp
> = {
  digit: /[0-9]/,
  lowercase: /[a-z]/,
  uppercase: /[A-Z]/,
  other: /[^a-zA-Z0-9]/,
};

/**
 * `.` matches anything but the four line terminators `PASSWORD_DESCRIPTION`
 * names. It is also the `.*$` that closes `PASSWORD_PATTERN`.
 */
const PASSWORD_SINGLE_LINE = /^.*$/;

/* eslint-disable-next-line security/detect-non-literal-regexp -- built from the
   module-local literals above, which no caller can influence */
const PASSWORD_PATTERN = new RegExp(
  `^${Object.values(PASSWORD_CHARACTER_CLASSES)
    .map((pattern) => `(?=.*${pattern.source})`)
    .join('')}.*$`
);

/**
 * Which of `PASSWORD_RULES` a typed value meets, measured as `passwordSchema`
 * measures it: after NFKC, with the length in code points.
 */
export function checkPasswordRules(
  value: string
): Record<PasswordRule, boolean> {
  const normalized = value.normalize('NFKC');
  const length = [...normalized].length;
  return {
    length: length >= PASSWORD_MIN && length <= PASSWORD_MAX,
    digit: PASSWORD_CHARACTER_CLASSES.digit.test(normalized),
    lowercase: PASSWORD_CHARACTER_CLASSES.lowercase.test(normalized),
    uppercase: PASSWORD_CHARACTER_CLASSES.uppercase.test(normalized),
    other: PASSWORD_CHARACTER_CLASSES.other.test(normalized),
    singleLine: PASSWORD_SINGLE_LINE.test(normalized),
  };
}

/**
 * ⚠️ Also checks EXISTING passwords, at sign-in, re-auth and `currentPassword`:
 * tightening this or `PASSWORD_MIN` locks out stored passwords that no longer
 * meet it.
 */
export const passwordSchema = z.preprocess(
  normalizePasswordInput,
  z
    .string(MSG_PASSWORD_REQUIRED)
    .min(PASSWORD_MIN, MSG_PASSWORD_TOO_SHORT)
    .max(PASSWORD_MAX, MSG_PASSWORD_TOO_LONG)
    .regex(PASSWORD_PATTERN, { error: MSG_PASSWORD_INVALID })
    // ⚠️ None of the four rules above survives into the document, because each
    // would refuse requests this schema accepts. NFKC folds an unbounded,
    // non-enumerable set of characters into the ASCII classes — a fullwidth or
    // mathematical capital, the Kelvin sign — so no published class can be true
    // of raw input; and it changes LENGTH in both directions — a ligature
    // expands one character into three, a combining sequence composes two into
    // one — so neither bound can be either.
    //
    // Same conclusion as the sanitized leaves reach for the same reason
    // (`STRICT_TEXT_DESCRIPTION`), and the rules travel as prose. The request
    // stays bounded by the body ceiling in `app.ts`, and `.max()` above still
    // refuses an over-long password before anything hashes it.
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: undefined,
      description: PASSWORD_DESCRIPTION,
    })
);

// Carries `PASSWORD_DESCRIPTION` forward: the converter emits only the wrapper's
// description, so the window note alone would drop every password rule.
export const reauthPasswordSchema = passwordSchema
  .optional()
  .describe(
    `${PASSWORD_DESCRIPTION} May be omitted while this session has an open password/passkey reauthentication window. Otherwise omission returns 401 REAUTH_REQUIRED.`
  );

// Saudi phone: strips non-digits, accepts 966XXXXXXXXX / 05XXXXXXXX / 5XXXXXXXX
const phoneCleanupRegex = /[^\d]/g;

export const phoneSchema = z.preprocess(
  // `string | number` is what the published `anyOf` below accepts, so it is also
  // what the exported input type has to say.
  (v: string | number) => {
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') return v;
    return normalizeArabicDigits(v).replaceAll(phoneCleanupRegex, '');
  },
  z
    .string(MSG_PHONE_REQUIRED)
    .min(1, MSG_PHONE_REQUIRED)
    .max(PHONE_NUMBER_MAX, MSG_PHONE_INVALID)
    .regex(/^(?:9665\d{8}|05\d{8}|5\d{8})$/, MSG_PHONE_INVALID)
    .transform((val) => {
      // Normalize to 9665XXXXXXXX
      if (val.startsWith('966')) return val;
      if (val.startsWith('05')) return '966' + val.slice(1);
      if (val.startsWith('5')) return '966' + val;
      return val;
    })
    // The bounds above describe the value AFTER separators are stripped, so
    // publishing them would reject input this schema accepts: `+966 51 234
    // 5678` is 16 characters against a cap meant for the 12 digits left.
    // `minLength: 1` survives that — no preprocess turns `''` into a number.
    .meta({
      type: undefined,
      minLength: undefined,
      maxLength: undefined,
      pattern: undefined,
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'number' }],
      description:
        'Saudi mobile number. Strings may contain separators or Arabic digits; numbers are also accepted. Normalized output is 9665XXXXXXXX.',
    })
);

// Optional phone: empty string / null → no number (null); otherwise validated
// and normalized by phoneSchema. The key is always present (nullable, not
// optional) so the inferred input/output shapes stay consistent for
// react-hook-form resolvers — callers send `null` to mean "no number".
export const optionalPhoneSchema = z
  .preprocess(
    (v: string | number | null) =>
      v == null || (typeof v === 'string' && v.trim() === '') ? null : v,
    phoneSchema.nullable()
  )
  // Must NOT inherit `phoneSchema`'s `minLength: 1`: the preprocess here runs
  // first and maps `''` to `null`, which is how a caller clears the number.
  .meta({
    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
    description:
      'Saudi mobile number, as accepted by the required form. `null` or an empty string clears it; omitting the key on an update leaves it unchanged.',
  });

/**
 * Passes a non-string through for the same reason as `slugPreprocess`.
 * @knipignore
 */
export const trimed = (v: string) => (typeof v === 'string' ? v.trim() : v);
/** @knipignore */
export const richTextSchema = z.unknown();

// eslint-disable-next-line security/detect-unsafe-regex
const colorRegex = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const opaqueColorRegex = /^#[0-9A-Fa-f]{6}$/;

/** @knipignore */
export const getColorSchema = (
  props: {
    optional?: boolean;
    alpha?: boolean;
  } = {}
) => {
  const { optional = false, alpha = true } = props;

  const schema = z
    .string(MSG_COLOR_INVALID)
    .regex(alpha ? colorRegex : opaqueColorRegex, MSG_COLOR_INVALID);

  const empty = optional ? null : '';

  return z.preprocess(
    (v: string | null | undefined) => {
      if (typeof v === 'string')
        return v.replaceAll(/\s+/g, '').toUpperCase() || empty;
      return v ?? empty;
    },
    optional ? schema.nullish() : schema
  );
};

/** Named because the document carries it as prose. */
const SLUG_MAX = 150;

/**
 * Passes a non-string through rather than coercing it to `''`, which would
 * satisfy the inner schema's `v === ''` escape hatches and accept `123`.
 */
export const slugPreprocess = (v: string) => {
  if (typeof v !== 'string') return v;

  return v
    .toLowerCase()
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
};

export const slugSchema = z.preprocess(
  slugPreprocess,
  z
    .string()
    .max(SLUG_MAX, MSG_SLUG_TOO_LONG)
    .meta({
      maxLength: undefined,
      description: `Lowercased, trimmed, and whitespace and repeated hyphens collapsed to single hyphens before validation, so it may be sent as typed. ${strictTextMaximum(SLUG_MAX)}`,
    })
    .refine(
      (v) => v === '' || /^[a-z0-9-]+$/.test(v),
      MSG_SLUG_INVALID_CHARACTERS
    )
    .refine((v) => v === '' || /[a-z]/.test(v), MSG_SLUG_DIGITS_ONLY)
);
// ⚠️ Nothing in this module may import from `../images/`. `svg-optimizer`
// imports `isomorphic-dompurify`, whose Node entry constructs a jsdom window at
// MODULE scope, so one import edge from here puts jsdom into every Next server
// bundle that renders a form and every Bun handler that validates one. An SVG
// schema belongs next to `sanitizeSvg`, taking a parser on the server as
// `sanitizeSvgServer` does.
