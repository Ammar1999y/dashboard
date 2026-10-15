import * as z from 'zod';

/** One flag per storage readiness check; the deep probe adds the last two. */
const storageChecksSchema = z.object({
  journalModeWal: z.boolean(),
  schemaVersion: z.boolean(),
  busyTimeout: z.boolean(),
  synchronousNormal: z.boolean(),
  postgres: z.boolean(),
  quickCheck: z.boolean().optional(),
  writable: z.boolean().optional(),
});

export const storageReadySchema = z.object({
  status: z.literal('ok'),
  checks: storageChecksSchema,
});

export const storageUnauthorizedSchema = z.object({
  status: z.literal('unauthorized'),
});

export const storageUnavailableSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('degraded'), checks: storageChecksSchema }),
  z.object({ status: z.literal('error') }),
]);
