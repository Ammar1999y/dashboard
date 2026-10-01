/** Reconciliation lists this prefix; nothing else in either bucket is ours. */
export const OBJECT_KEY_PREFIX = 'm/';

/**
 * Identical in both buckets. No filename (stale on the first rename, and it
 * would leak into public URLs) and no entity prefix (an owner created in the
 * same form has no id yet).
 *
 * ⚠️ Embedding the primary key is what makes a key unique to one row; the
 * year/month is only for humans browsing the console.
 */
export function objectKey(
  fileId: string,
  extension: string,
  now = new Date()
): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${OBJECT_KEY_PREFIX}${year}/${month}/${fileId}.${extension}`;
}
