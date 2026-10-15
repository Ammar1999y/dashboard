import type * as z from 'zod';

/**
 * One English sentence per field, for the generated document only. Keyed by
 * the schema's own shape, so a renamed or removed field fails to compile.
 */
export type FieldDocs<S extends z.ZodObject> = {
  readonly [K in keyof S['shape']]?: string;
};

export interface FieldDocsEntry {
  readonly schema: z.ZodObject;
  readonly docs: Readonly<Record<string, string | undefined>>;
}

/** The sentence of one schema instance, where no object field reaches it. */
export interface SchemaDocsEntry {
  readonly schema: z.ZodType;
  readonly description: string;
}

export type DocsEntry = FieldDocsEntry | SchemaDocsEntry;

/**
 * Pairs a schema with its field prose. Only `*.docs.ts` files call it, and
 * nothing outside them imports one: the prose stays out of the browser bundle
 * and is loaded by the server when it first builds the document.
 *
 * A sentence may name a server-only value as `{{name}}`; the server's loader
 * fills it, and refuses a name it does not know.
 */
export const fieldDocs = <S extends z.ZodObject>(
  schema: S,
  docs: FieldDocs<S>
): FieldDocsEntry => ({ schema, docs });

/** `fieldDocs` for an instance reused bare, or for an object as a whole. */
export const schemaDocs = (
  schema: z.ZodType,
  description: string
): SchemaDocsEntry => ({ schema, description });
