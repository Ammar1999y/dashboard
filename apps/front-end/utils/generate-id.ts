import type { EntityID } from '@app/shared/types';

import { v7 as uuidv7 } from 'uuid';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A short key for client-only state, such as a filter row or a picked file. */
export function generateId({ length = 12 }: { length?: number } = {}): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

/** The id the server would assign: rows created before they are saved need one. */
export const generateEntityId = (): EntityID => uuidv7();
