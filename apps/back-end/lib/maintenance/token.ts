import { timingSafeEqual } from 'node:crypto';

import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';

import { logLine } from '@/utils/log';

export const MAINTENANCE_TOKEN_HEADER = 'x-maintenance-token';

/**
 * The bearer check for `GET /api/health/storage`. An unset configured token
 * never matches: treating it as "no auth required" would open the probe on a
 * deploy that forgot the variable.
 */
export function maintenanceTokenMatches(provided: string | null): boolean {
  const matched = compare(provided);

  if (!matched)
    logLine('error', {
      msg: 'maintenance token rejected',
      reason: provided ? 'mismatch' : 'absent',
      configured: SQLITE_MAINTENANCE_TOKEN.length > 0,
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
