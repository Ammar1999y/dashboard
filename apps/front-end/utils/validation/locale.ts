import * as z from 'zod';

/**
 * Arabic for every issue no schema node wrote a message for.
 *
 * The schemas here author their own Arabic messages, but only for the rules
 * they state — a bare `z.string()` that receives a number, or a failed
 * `z.union`, falls through to Zod's built-in text. Those go straight into a
 * toast via `flattenErrors`, so the user would read
 * "Invalid input: expected string, received number".
 *
 * Set globally rather than per schema, because a node is exactly where it gets
 * forgotten. A message a node does author still wins.
 */
z.config(z.locales.ar());
