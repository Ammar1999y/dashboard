/**
 * No endpoint's body or answer widens a field to `unknown`. Type-only, so it
 * costs no bundle; every consumer checks it when it compiles these sources.
 *
 * A multipart body is a `File`, typed and never parsed, and a bound entry's
 * raw answer is an outside consumer's shape, so neither is walked. A plugin
 * entry's raw answer is this project's, so it is.
 */
import type * as auth from './auth';
import type * as betterAuth from './better-auth';
import type * as dev from './dev';
import type * as health from './health';
import type * as media from './media';
import type * as openapi from './openapi';
import type * as permissions from './permissions';
import type * as users from './users';
import type * as z from 'zod';

/**
 * The keys at which `T` widens a field to `unknown`, at any depth.
 *
 * `z.preprocess` takes its INPUT type from the callback's parameter annotation
 * alone, so a preprocessor written `(v) =>` or `(v: unknown) =>` silently makes
 * its field `unknown` here — and a field typed `unknown` accepts every value a
 * client can send, which is the one thing this guard exists to prevent. The
 * fix is to annotate the offending preprocess parameter with the wire type, as
 * `validation/rules.ts` describes.
 */
export type UnknownFieldsOf<T, Depth extends readonly unknown[] = []> =
  // Bounded rather than unbounded: a body is a handful of levels deep, and an
  // unbounded walk is what makes this kind of type explode on a recursive one.
  Depth['length'] extends 5
    ? never
    : T extends readonly (infer Element)[]
      ? UnknownFieldsOf<Element, [...Depth, 0]>
      : T extends object
        ? {
            [K in keyof T]-?: unknown extends T[K]
              ? K
              : UnknownFieldsOf<T[K], [...Depth, 0]>;
          }[keyof T]
        : never;

export type Assert<T extends true> = T;

type Entry =
  | (typeof auth)[keyof typeof auth]
  | (typeof betterAuth)[keyof typeof betterAuth]
  | (typeof dev)[keyof typeof dev]
  | (typeof health)[keyof typeof health]
  | (typeof media)[keyof typeof media]
  | (typeof openapi)[keyof typeof openapi]
  | (typeof permissions)[keyof typeof permissions]
  | (typeof users)[keyof typeof users];

/**
 * The bodies with a deliberately opaque region: `{ response }`, a WebAuthn
 * assertion this layer does not model, read field by field by the verifier.
 * Named entry by entry rather than exempted by shape (e.g. "records are
 * fine"), so the next opaque body is a decision someone has to write down
 * instead of a hole that opens by itself. The exemption drops the opaque KEY,
 * not the entry: every other field of those bodies is still checked.
 */
type OpaqueBody =
  | typeof betterAuth.reauthPasskeyVerify
  | typeof betterAuth.twoFactorPasskeyVerify;

type BodyOf<E> = E extends {
  readonly bodyKind: 'json';
  readonly body: infer B extends z.ZodType;
}
  ? E extends OpaqueBody
    ? Omit<z.input<B>, 'response'>
    : z.input<B>
  : never;

type PluginEntry = (typeof betterAuth)[keyof typeof betterAuth];

type DataOf<E> = E extends { readonly response: infer R }
  ? R extends { readonly raw: infer S extends z.ZodType }
    ? E extends PluginEntry
      ? z.output<S>
      : never
    : R extends { readonly data: infer D extends z.ZodType }
      ? z.output<D>
      : R extends z.ZodType
        ? z.output<R>
        : never
  : never;

export type EndpointFieldsAreTyped = Assert<
  [UnknownFieldsOf<BodyOf<Entry>> | UnknownFieldsOf<DataOf<Entry>>] extends [
    never,
  ]
    ? true
    : false
>;
