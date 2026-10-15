import type { Tx } from '@/db';
import type { AuditAction } from '@/db/schema';
import type { HandlerRequestMeta } from '@/lib/http/contract';
import type { EntityID } from '@app/shared/types';

import { auditLogs } from '@/db/schema';

import { API_PATH_MAX, USER_AGENT_MAX } from './constants';

/** Request metadata stored on every audit row. */
export interface AuditMeta {
  ip: string | null;
  userAgent: string | null;
  apiPath: string;
}

/** Cut to the `user_agent` column width every table shares. */
export function boundedUserAgent(
  userAgent: string | null | undefined
): string | undefined {
  return userAgent?.slice(0, USER_AGENT_MAX);
}

/** Cut to the `audit_logs` column widths. */
export function boundedAuditMeta(
  ip: string | null,
  userAgent: string | null | undefined,
  apiPath: string
): AuditMeta {
  return {
    ip,
    userAgent: boundedUserAgent(userAgent) ?? null,
    apiPath: apiPath.slice(0, API_PATH_MAX),
  };
}

export function getAuditMeta(
  ctx: Pick<HandlerRequestMeta, 'ip' | 'userAgent' | 'apiPath'>
): AuditMeta {
  return boundedAuditMeta(ctx.ip || null, ctx.userAgent, ctx.apiPath);
}

/**
 * Key fragments whose values must never be stored in an audit row, matched
 * against a normalised key so `new_password` and `newPassword` behave alike.
 *
 * A net, not a boundary: a secret inside a free-text value is invisible to it.
 * Callers pass explicit, named fields; nothing here licenses handing this
 * function a credential.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'credential',
  'pepper',
  'apikey',
  'privatekey',
  'passphrase',
  'signature',
  'authorization',
  'cookie',
  'bearer',
  'jwt',
  'salt',
  'hash',
];

/**
 * Is this key/value pair a secret? Two exemptions come before the fragment
 * denylist:
 *
 * 1. **A boolean is never a secret.** A flag ABOUT a credential
 *    (`passwordChanged`, `passwordHashUpgraded`) must survive, or the event it
 *    records leaves no trace in `oldData`, `newData` or `changedFields`.
 * 2. **`safeFields`, declared by the event.** Non-boolean metadata whose name
 *    mentions a credential — a pepper VERSION id, not the pepper — is named by
 *    the call site that knows the shape of its own event.
 */
function isSensitiveAuditKey(
  key: string,
  value: unknown,
  safeFields?: ReadonlySet<string>
): boolean {
  if (typeof value === 'boolean' || safeFields?.has(key)) return false;
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

// In JSON *characters*, not UTF-8 bytes: Arabic text costs 2 bytes per
// character, so a stored row can be ~2x this.
const MAX_AUDIT_JSON_CHARS = 32_768;
const MAX_AUDIT_DEPTH = 6;
const AUDIT_PREVIEW_CODE_POINTS = 1024;

/**
 * Bound a value for a `jsonb` column, and hand back one the driver will accept.
 *
 * The re-parse is load-bearing: `redactValue` builds every level with
 * `Object.create(null)`, and Drizzle's `is()` — run on every value passed to
 * `.values()` — reads `Object.getPrototypeOf(value).constructor`, which throws
 * on a null prototype. Not a spread, because this also runs on `changedFields`,
 * an array, which a spread would turn into an object. The driver serializes
 * the value anyway, so the round trip is an identity on the column — which is
 * also why the cast is safe.
 */
function clampJson<T>(value: T): T | { _truncated: true; preview: string } {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= MAX_AUDIT_JSON_CHARS) return JSON.parse(s) as T;
  // By code point: a cut through a surrogate pair leaves a lone half, which
  // `jsonb` refuses.
  const preview = s[Symbol.iterator]().take(AUDIT_PREVIEW_CODE_POINTS);
  return { _truncated: true, preview: preview.toArray().join('') };
}

const MAX_AUDIT_NODES = 2000;
const BUDGET_MARKER = '_truncated';

/**
 * Removes sensitive fields at every level, within a fixed work budget.
 *
 * The budget bounds the WORK, not just the output, so iteration stops at the
 * limit and leaves a single marker. `for...in` + `hasOwn` rather than
 * `Object.entries`, which would read every value — running any getters —
 * before the budget is consulted.
 */
function redactValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  safeFields?: ReadonlySet<string>
): unknown {
  if (budget.nodes <= 0) return '[budget-limit]';
  budget.nodes -= 1;
  if (depth >= MAX_AUDIT_DEPTH) return '[depth-limit]';

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (budget.nodes <= 0) {
        items.push('[budget-limit]');
        break;
      }
      items.push(redactValue(item, depth + 1, budget, safeFields));
    }
    return items;
  }

  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();

  // Prototype-free: `safe['__proto__'] = v` on a plain object mutates the
  // prototype instead of recording a key, so the field would silently vanish.
  const safe: Record<string, unknown> = Object.create(null);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (budget.nodes <= 0) {
      safe[BUDGET_MARKER] = true;
      break;
    }
    // Read only after the budget check — the read itself is the expensive part
    // when the property is a getter.
    const item = (value as Record<string, unknown>)[key];
    if (isSensitiveAuditKey(key, item, safeFields)) continue;
    safe[key] = redactValue(item, depth + 1, budget, safeFields);
  }
  return safe;
}

function stripSensitive<T extends Record<string, unknown>>(
  data: T,
  safeFields?: ReadonlySet<string>
): Partial<T> {
  return redactValue(
    data,
    0,
    { nodes: MAX_AUDIT_NODES },
    safeFields
  ) as Partial<T>;
}

function computeChangedFields(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
  metadataFields?: readonly string[],
  safeFields?: ReadonlySet<string>
): string[] {
  const skip = new Set(metadataFields);
  const changed: string[] = [];
  for (const [key, newValue] of Object.entries(newData)) {
    if (
      newValue === undefined ||
      skip.has(key) ||
      isSensitiveAuditKey(key, newValue, safeFields)
    )
      continue;
    const oldVal = JSON.stringify(oldData[key] ?? null);
    const newVal = JSON.stringify(newValue ?? null);
    if (oldVal !== newVal) changed.push(key);
  }
  return changed;
}

interface AuditLogParams {
  userId: EntityID;
  userEmail: string;
  action: AuditAction;
  tableName: string;
  recordId: EntityID;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  /**
   * Keys in `oldData`/`newData` that describe the EVENT rather than the record
   * (`auditVersion`, `forUserId`, `changedPermissions`). Excluded from
   * `changedFields` so it only ever lists real business changes.
   */
  metadataFields?: readonly string[];
  /**
   * Keys this event declares non-secret despite matching the generic denylist.
   * Booleans never need listing here; see `isSensitiveAuditKey`.
   */
  safeFields?: readonly string[];
  /**
   * Skip the insert when an UPDATE turns out to have changed nothing. Opt-in,
   * because "no changed business fields" is meaningful for some events, and
   * for others only noise beside a sibling event that carries the real change.
   */
  skipIfUnchanged?: boolean;
  meta: AuditMeta;
}

/**
 * Must be called inside the same transaction as the mutation to guarantee atomicity.
 *
 * The trail lives in the database it audits, so anyone with write access to
 * that database can erase it; an external append-only sink is the fix.
 */
export async function auditLog(tx: Tx, params: AuditLogParams) {
  const { userId, userEmail, action, tableName, recordId, meta } = params;

  const safeFields = params.safeFields ? new Set(params.safeFields) : undefined;

  const oldData = params.oldData
    ? stripSensitive(params.oldData, safeFields)
    : null;
  const newData = params.newData
    ? stripSensitive(params.newData, safeFields)
    : null;

  const changedFields =
    action === 'UPDATE' && oldData && newData
      ? computeChangedFields(
          oldData,
          newData,
          params.metadataFields,
          safeFields
        )
      : null;

  // Only when both sides were supplied — `changedFields` is null (not empty)
  // when the caller gave no before/after pair, and that is not a no-op.
  if (params.skipIfUnchanged && changedFields?.length === 0) return;

  await tx.insert(auditLogs).values({
    userId,
    userEmail,
    action,
    tableName,
    recordId,
    oldData: oldData ? clampJson(oldData) : null,
    newData: newData ? clampJson(newData) : null,
    changedFields: changedFields ? clampJson(changedFields) : null,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    apiPath: meta.apiPath,
  });
}
