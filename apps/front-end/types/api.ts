import * as z from 'zod';

/** What the server keeps beside a row's own fields, and always sends. */
export const storedRowSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type StoredRow = z.output<typeof storedRowSchema>;
