/** Every code point a string can hold, as a string each: surrogates and NUL excluded. */
export function everyCodePoint(): string[] {
  const characters: string[] = [];
  for (let point = 1; point <= 0x10_ff_ff; point++)
    if (point < 0xd8_00 || point > 0xdf_ff)
      characters.push(String.fromCodePoint(point));
  return characters;
}
