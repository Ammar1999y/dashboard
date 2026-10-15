import * as z from 'zod';

/**
 * Not strict, unlike every other query schema: a key the probe does not know
 * is ignored as it always was, so a probe URL with an extra parameter keeps
 * passing instead of failing the deployment's health check.
 */
export const storageHealthQuerySchema = z.object({
  deep: z
    .string()
    .optional()
    .meta({ examples: ['1'] }),
});
