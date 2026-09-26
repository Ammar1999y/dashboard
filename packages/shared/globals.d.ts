/**
 * The entire Node surface this package may touch. Declared rather than taken
 * from `@types/node` so that a Node-only call is a compile error in this
 * package's own `tsc` (the consumers' programs carry Node and Bun types and
 * would not catch it). The sources run in the browser bundle too.
 */
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};
