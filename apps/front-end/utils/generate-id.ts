const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateId({ length = 12 }: { length?: number } = {}): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    id += ALPHABET[byte % ALPHABET.length];
  }
  return id;
}
