/** Plain-text messages cannot use `<bdi>` to keep an interpolated value in its own direction. */
export const isolate = (text: string) => `\u{2068}${text}\u{2069}`;
