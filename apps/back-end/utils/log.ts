// Diagnostic call sites pass structured objects (`{ msg, attempt, error }`).
// `String(obj)` would collapse those to "[object Object]" and destroy the
// context incident response needs, so they are serialized field by field with
// hard bounds and recursive redaction instead.

import { CustomError } from '@app/shared/error-class';
import { CUSTOM_AUTH_CODE, ROUTING_CODES } from '@app/shared/error-codes';

const LOG_MAX_DEPTH = 4;
const LOG_MAX_ITEMS = 20;
const LOG_MAX_KEYS = 30;
const LOG_MAX_STRING = 256;
const LOG_REDACTED = '[redacted]';

/**
 * Key fragments whose values never belong in a log line, matched ANYWHERE in
 * the key.
 *
 * ⚠️ A NET, not a guarantee. It cannot see a secret inside free text (a driver
 * error's message carries its bound parameters; a provider's carries the
 * payload it rejected) and it cannot know a key nobody listed. Those need a
 * boundary at the source — see `serializeQueryError` and `sendOtp`. The rule is
 * still: never hand a secret to a logger.
 */
const SENSITIVE_LOG_FRAGMENTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'bearer',
  'credential',
  'pepper',
  'apikey',
  'privatekey',
  'signature',
  'jwt',
  'salt',
  'passphrase',
  'otp',
];

/**
 * `hash` and `code` are secrets in one position and diagnostics in another, so
 * they are matched positionally rather than as substrings: `hash` at the end is
 * the digest (`passwordHash`), at the start it describes one (`hashUpgraded`);
 * `code` at the end is a status (`statusCode`), alone it is the OTP.
 */
const SENSITIVE_LOG_SUFFIXES = ['hash'];
const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set([
  'code',
  'plaintextcode',
  'verificationcode',
  'resetcode',
]);

/**
 * Extra diagnostic fields worth keeping off Error-like objects (PG codes).
 *
 * `errno` is in this list because `bun:sql` puts the SQLSTATE there and its
 * `code` on a `PostgresError` is the constant `'ERR_POSTGRES_SERVER_ERROR'` for
 * every constraint violation — so without `errno` a driver error logs a name for
 * a class of failures instead of the one code that identifies which failure it
 * was. On Node errors the same key is a negative integer (`-4058`), which the
 * numeric branch below keeps as-is.
 */
const ERROR_DETAIL_KEYS = [
  'code',
  'errno',
  'constraint',
  'status',
  'statusCode',
];

/**
 * SQLSTATE (`23505`) or a Node/Nodemailer class (`ECONNRESET`). An Error's
 * `code` is kept only when it matches this — six plain digits, an OTP, does not.
 */
const DRIVER_ERROR_CODE = /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{1,31})$/;

/** The keys in `ERROR_DETAIL_KEYS` that must look like driver metadata. */
const SHAPE_CHECKED_ERROR_KEYS = new Set(['code', 'errno']);

function isSensitiveLogKey(key: string, value: unknown): boolean {
  // A boolean cannot carry a credential, so a flag ABOUT one is safe by
  // construction — same rule as `lib/audit/index.ts`.
  if (typeof value === 'boolean') return false;
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  if (
    SENSITIVE_LOG_KEYS.has(normalized) ||
    SENSITIVE_LOG_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  )
    return true;
  return SENSITIVE_LOG_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

const LOG_CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

function stripLogControlChars(value: string): string {
  return value.replaceAll(LOG_CONTROL_CHARS, ' ');
}

function clampLogString(value: string): string {
  const clean = stripLogControlChars(value);
  return clean.length > LOG_MAX_STRING
    ? clean.slice(0, LOG_MAX_STRING - 1) + '\u{2026}'
    : clean;
}

/**
 * Drizzle's message markers. Checked as well as the `query`/`params` shape
 * because a wrapper or a structured clone can copy `message` while dropping
 * those fields.
 */
const QUERY_PARAMS_MARKER = 'params:';
const QUERY_ERROR_MARKERS = ['Failed query:', QUERY_PARAMS_MARKER] as const;

/**
 * A driver error whose message carries the statement's BOUND PARAMETERS.
 *
 * Drizzle throws `Failed query: <sql>\nparams: <values>`, and those values are
 * routinely secrets (session tokens, password hashes, contact details) that
 * key-based redaction cannot reach inside `message`.
 */
function isParameterBearingQueryError(error: object): boolean {
  if ('query' in error && 'params' in error) return true;
  const message: unknown = Reflect.get(error, 'message');
  // Both markers anywhere in the text, so a contextual wrapper
  // (`new Error(\`context: ${dbError.message}\`)`) still matches, and the pair
  // keeps it off messages that merely mention a query.
  return (
    typeof message === 'string' &&
    QUERY_ERROR_MARKERS.every((marker) => message.includes(marker))
  );
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Per-field shape checks on the metadata kept from a query error chain.
 *
 * `errno` is the SQLSTATE `bun:sql` reports; `code` is the SQLSTATE of other
 * PostgreSQL clients or Bun's own class (`ERR_POSTGRES_CONNECTION_CLOSED`).
 * `detail`, `where` and `hint` are never kept: PostgreSQL puts row values and
 * bound parameters there.
 *
 * Being precise about the limit: this bounds what a FABRICATED query-shaped
 * error could smuggle through — it does not eliminate it, because a token can
 * be shaped like an identifier. Real driver metadata is safe; the residual risk
 * is an attacker who can already throw arbitrary objects into a log call.
 */
const QUERY_ERROR_SAFE_FIELDS = {
  code: DRIVER_ERROR_CODE,
  errno: /^[0-9A-Z]{5}$/,
  constraint: IDENTIFIER,
  table: IDENTIFIER,
  // A string only: Bun also sets a numeric `column` for the JS source position.
  column: IDENTIFIER,
  routine: /^[A-Za-z_][A-Za-z0-9_]{0,62}$/,
} as const;

const ERROR_CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const QUERY_MESSAGE_WITHHELD = '[withheld: query errors echo bound parameters]';

function pickQuerySafeKeys(value: object): Record<string, unknown> {
  // Own properties only, into a prototype-free record — the same rule the
  // generic serializer uses. The written keys are fixed here, but an inherited
  // `code`/`constraint` off a caller-supplied prototype would otherwise be
  // reported as driver metadata it isn't.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, pattern] of Object.entries(QUERY_ERROR_SAFE_FIELDS)) {
    if (!Object.hasOwn(value, key)) continue;
    const entry: unknown = Reflect.get(value, key);
    if (typeof entry === 'string' && pattern.test(entry)) out[key] = entry;
  }
  return out;
}

/**
 * `DrizzleQueryError` reports `name === 'Error'`, so the constructor is the
 * informative half; anything not shaped like a class name gets `fallback`.
 */
function queryErrorClass(value: object, fallback: string): string {
  const name: unknown = Reflect.get(value, 'name');
  const ctor: unknown = Reflect.get(value, 'constructor');
  const ctorName: unknown =
    typeof ctor === 'function' ? Reflect.get(ctor, 'name') : undefined;
  for (const candidate of [name, ctorName])
    if (
      typeof candidate === 'string' &&
      candidate !== 'Error' &&
      candidate !== 'Object' &&
      ERROR_CLASS_NAME.test(candidate)
    )
      return candidate;
  return fallback;
}

/** The SQL text survives; everything from the parameter list on does not. */
function queryMessageWithoutParams(message: string): string {
  const at = message.indexOf(QUERY_PARAMS_MARKER);
  return at === -1
    ? QUERY_MESSAGE_WITHHELD
    : clampLogString(message.slice(0, at).trimEnd());
}

/**
 * PostgreSQL quotes identifiers and echoed values alike, and writes an invalid
 * byte sequence as `0x..`. A trailing `: "<value>"` is cut whole, because the
 * value may itself contain a quote; any other quoted text survives only when
 * shaped like an identifier, and an unpaired last quote cuts the rest.
 */
function driverMessageWithoutValues(message: string): string {
  const tail = message.indexOf(': "');
  const head = tail === -1 ? message : `${message.slice(0, tail)}: [redacted]`;
  const balanced =
    head.split('"').length % 2 === 1
      ? head
      : `${head.slice(0, head.lastIndexOf('"'))}[redacted]`;
  const unquoted = balanced.replaceAll(/"([^"]*)"/g, (quoted, inner: string) =>
    IDENTIFIER.test(inner) ? quoted : '[redacted]'
  );
  return clampLogString(unquoted.replaceAll(/0x[0-9a-f]{2}/gi, '[redacted]'));
}

/**
 * A parameter-bearing query error, walked down its `cause` chain with its own
 * rules rather than the ordinary ones: every level carries or echoes the bound
 * values somewhere — the Drizzle message's `params:`, the driver message's
 * quoted value, the driver's `detail` — so each keeps its class, its message
 * with those parts cut, and allowlisted metadata only.
 */
function serializeQueryError(
  error: object,
  depth = 0,
  fallbackName = 'QueryError'
): Record<string, unknown> {
  const message: unknown = Reflect.get(error, 'message');
  let text: string | undefined;
  if (isParameterBearingQueryError(error))
    text =
      typeof message === 'string'
        ? queryMessageWithoutParams(message)
        : QUERY_MESSAGE_WITHHELD;
  else if (typeof message === 'string')
    text = driverMessageWithoutValues(message);

  const out: Record<string, unknown> = {
    name: queryErrorClass(error, fallbackName),
    ...(text !== undefined && { message: text }),
    ...pickQuerySafeKeys(error),
  };

  const cause: unknown = Reflect.get(error, 'cause');
  if (cause && typeof cause === 'object' && depth < LOG_MAX_DEPTH)
    out.cause = serializeQueryError(cause, depth + 1, 'DriverError');

  return out;
}

/**
 * An answered `APIError`'s auth code: its message is then the Arabic product
 * copy for that code, not a diagnostic. `null` for any other error.
 */
function answeredAuthCode(error: Error): string | null {
  // By name: an APIError may cross a module-instance boundary.
  if (error.name !== 'APIError') return null;
  const body: unknown = Reflect.get(error, 'body');
  const code: unknown =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, 'code')
      : null;
  return code === CUSTOM_AUTH_CODE || ROUTING_CODES.has(code)
    ? String(code)
    : null;
}

/** The first stack frame: where it was thrown, without quoting its message. */
function thrownAt(error: Error): string | undefined {
  const frame = error.stack
    ?.split('\n')
    .find((line) => line.trimStart().startsWith('at '));
  return frame === undefined
    ? undefined
    : clampLogString(frame.trimStart().slice(3));
}

function serializeErrorLike(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
  budget: { nodes: number }
): Record<string, unknown> {
  if (isParameterBearingQueryError(error)) return serializeQueryError(error);

  const out: Record<string, unknown> = {
    name: clampLogString(error.name || 'Error'),
  };
  // Product copy stays out of logs; status, code and throw site identify it.
  const authCode = answeredAuthCode(error);
  if (authCode !== null) out.authCode = authCode;
  else if (error instanceof CustomError) out.thrownAt = thrownAt(error);
  else
    // `message` is kept, and a key-based rule cannot see inside it: anything
    // that builds a message from a secret must be contained where it is thrown
    // (see `serializeQueryError`, `sendOtp`). This is not a no-secrets guarantee.
    out.message = clampLogString(error.message || '');
  for (const key of ERROR_DETAIL_KEYS) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;
    // A plain object's `code` is redacted outright; an Error's is kept because
    // that is where driver metadata lives. The shape test reconciles the two.
    out[key] =
      SHAPE_CHECKED_ERROR_KEYS.has(key) && !DRIVER_ERROR_CODE.test(value)
        ? LOG_REDACTED
        : clampLogString(value);
  }
  if (error.cause != null && depth < LOG_MAX_DEPTH)
    out.cause = serializeLogValue(error.cause, depth + 1, seen, budget);
  return out;
}

/**
 * Total values one call may visit.
 *
 * Depth, item, key and string caps each bound one dimension, but their PRODUCT
 * is large (4 deep x 30 keys per level), so a wide-and-deep payload could still
 * cost far more than any log line is worth. This is the flat ceiling across the
 * whole walk.
 */
const LOG_MAX_NODES = 2000;

function serializeLogValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  // Required, not defaulted: every entry point creates the budget so one
  // traversal cannot silently start a fresh allowance mid-walk.
  budget: { nodes: number }
): unknown {
  if (budget.nodes <= 0) return '[budget limit]';
  budget.nodes -= 1;
  if (value === null) return null;

  switch (typeof value) {
    case 'undefined': {
      return undefined;
    }
    case 'boolean': {
      return value;
    }
    case 'number': {
      return Number.isFinite(value) ? value : String(value);
    }
    case 'bigint': {
      return `${value}n`;
    }
    case 'string': {
      return clampLogString(value);
    }
    case 'function':
    case 'symbol': {
      return `[${typeof value}]`;
    }
  }

  const obj: object = value;
  if (seen.has(obj)) return '[circular]';

  if (obj instanceof Date)
    return Number.isNaN(obj.getTime()) ? '[invalid date]' : obj.toISOString();
  if (obj instanceof Error) {
    seen.add(obj);
    return serializeErrorLike(obj, depth, seen, budget);
  }
  if (depth >= LOG_MAX_DEPTH) return '[depth limit]';

  seen.add(obj);

  if (Array.isArray(obj)) {
    const items = obj
      .slice(0, LOG_MAX_ITEMS)
      .map((item) => serializeLogValue(item, depth + 1, seen, budget));
    if (obj.length > LOG_MAX_ITEMS)
      items.push(`[+${obj.length - LOG_MAX_ITEMS} more]`);
    return items;
  }

  if (obj instanceof Map || obj instanceof Set)
    return `[${obj.constructor.name}(${obj.size})]`;

  // A non-Error object can still be a driver error shape (some drivers throw
  // plain objects). Apply the same rule rather than trusting `instanceof`,
  // and keep the same allowlisted metadata an Error-shaped one keeps.
  if (isParameterBearingQueryError(obj)) return serializeQueryError(obj);

  // Prototype-free record: `out[key] = …` with a key of `__proto__` on a plain
  // object hits the setter and mutates this record's prototype instead of
  // recording a field — the field silently disappears from the log line.
  const out: Record<string, unknown> = Object.create(null);
  let keyCount = 0;
  // `for...in` rather than `Object.entries`, so the key cap bounds the work,
  // getter calls included, and not only the output. `hasOwn` keeps inherited
  // keys out.
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue;
    if (keyCount >= LOG_MAX_KEYS) {
      out._truncated = true;
      break;
    }
    keyCount += 1;
    const entry: unknown = Reflect.get(obj, key);
    out[key] = isSensitiveLogKey(key, entry)
      ? LOG_REDACTED
      : serializeLogValue(entry, depth + 1, seen, budget);
  }
  return out;
}

/**
 * Bounded, redacting serializer for log payloads. Always returns a
 * single-line string: depth/collection/length limited, sensitive keys
 * replaced, nested `Error`s reduced to safe name/message/code fields.
 * Exported so the behavior can be asserted directly in tests.
 */
export function serializeForLog(input: unknown, maxLength = 1024): string {
  let out: string;
  try {
    const value = serializeLogValue(input, 0, new WeakSet(), {
      nodes: LOG_MAX_NODES,
    });
    out =
      typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    out = '[unserializable log payload]';
  }
  out = stripLogControlChars(out);
  if (out.length <= maxLength) return out;
  // The ellipsis must fit inside the cap.
  return maxLength <= 3
    ? out.slice(0, Math.max(0, maxLength))
    : out.slice(0, maxLength - 3) + '...';
}

/** The class of a thrown value, for a log line. */
export function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown';
}

/**
 * What a `CustomError` is logged with besides its class, wherever it is
 * logged: where it was thrown and the diagnosis it carries as `cause`.
 */
export function customErrorFields(error: CustomError) {
  return { thrownAt: thrownAt(error), cause: error.cause };
}

/** The one line a 5xx `CustomError` is logged with, by whichever boundary answers it. */
export function logServerErrorResponse(error: CustomError): void {
  logSanitized('error', {
    msg: 'server error response',
    status: error.status,
    errorClass: errorClassOf(error),
    ...customErrorFields(error),
  });
}

/**
 * Work whose failure must not change the answer: a fault is logged once and
 * answered `undefined`. Never for a read or a consume a refusal depends on; a
 * fault there must propagate to the boundary that answers 503 or 500.
 */
export async function bestEffort<T>(
  msg: string,
  work: () => Promise<T>,
  fields: Record<string, unknown> = {}
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    logSanitized('error', { msg, ...fields, error });
    return undefined;
  }
}

/** `errorClassOf`, but a non-`Error` throw is named by its `typeof`. */
export function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

type LogLevel = 'log' | 'warn' | 'error';

/**
 * One unredacted JSON line. For fields this codebase chose itself; anything
 * carrying caller or driver data goes through `logSanitized`.
 */
export function logLine(level: LogLevel, line: Record<string, unknown>): void {
  console[level](JSON.stringify(line));
}

export function logSanitized(level: LogLevel, payload: unknown): void {
  console[level](sanitizeForLog(payload));
}

export function sanitizeForLog(input: unknown, maxLength = 1024) {
  // Development gets an expandable structure instead of a JSON string, still
  // redacted: redaction is not a production-only concern.
  if (process.env.NODE_ENV === 'development') {
    // Walking an unknown value can throw (a hostile getter, a Proxy trap), and
    // a logging call must never take the request down.
    try {
      return serializeLogValue(input, 0, new WeakSet(), {
        nodes: LOG_MAX_NODES,
      });
    } catch {
      return '[unserializable log payload]';
    }
  }
  return serializeForLog(input, maxLength);
}
