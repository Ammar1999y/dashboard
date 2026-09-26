/**
 * A lexicographically sortable UUIDv7. Dependency-free so `db/schema.ts` can
 * import it. The generator may advance the embedded timestamp to keep sort
 * order, so it is not a wall-clock creation time.
 */
export function generateUuidV7(): string {
  return Bun.randomUUIDv7();
}
