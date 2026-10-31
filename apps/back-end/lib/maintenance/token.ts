import { timingSafeEqual } from 'node:crypto';

import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';

import { logLine } from '@/utils/log';

/**
 * The bearer check for `GET /api/health/storage`. An unset configured token
 * never matches: treating it as "no auth required" would open the probe on a
 * deploy that forgot the variable.
 */
export function maintenanceTokenMatches(provided: string | null): boolean {
  const matched = compare(provided);
  const configured = SQLITE_MAINTENANCE_TOKEN.length > 0;

  // A wrong or missing token is anyone's to send, so it must not page anyone;
  // the failing health check is the operator's signal. An unset token is a
  // misconfiguration.
  if (!matched)
    logLine(configured ? 'warn' : 'error', {
      msg: 'maintenance token rejected',
      reason: provided ? 'mismatch' : 'absent',
      configured,
    });
  return matched;
}

function compare(provided: string | null): boolean {
  if (!provided || !SQLITE_MAINTENANCE_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SQLITE_MAINTENANCE_TOKEN);
  // `timingSafeEqual` throws on a length mismatch, which would itself be an oracle.
  return a.length === b.length && timingSafeEqual(a, b);
}
