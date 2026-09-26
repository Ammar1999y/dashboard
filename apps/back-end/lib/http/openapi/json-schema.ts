import * as z from 'zod';

export type JsonSchema = Record<string, unknown>;

export const OPENAPI_VERSION = '3.1.1';

export function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Zod → JSON Schema, or null when the converter throws.
 *
 * `unrepresentable: 'any'` because several schemas use `z.preprocess` and
 * refinements with no JSON Schema equivalent: a document missing one constraint
 * beats a route that 500s, and the catch keeps one schema that breaks the
 * converter from taking the whole contract down.
 *
 * `$schema` is dropped because the result is spliced in as a subschema, and
 * under 2020-12 that keyword belongs to a schema resource root.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    const { $schema: _dialect, ...converted } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    });
    return converted;
  } catch {
    return null;
  }
}

/** Repair Better Auth's OpenAPI-3.0-era schema fragments for a 3.1 document. */
export function normalizeOpenApi31(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenApi31);
  if (!isJsonSchema(value)) return value;

  const normalized: JsonSchema = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'nullable')
      .map(([key, child]) => [key, normalizeOpenApi31(child)])
  );

  if (normalized.type === 'json') {
    normalized.type = 'object';
    normalized.additionalProperties = true;
  }

  if (value.nullable === true) {
    if (typeof normalized.type === 'string')
      normalized.type = [normalized.type, 'null'];
    else if (Array.isArray(normalized.type)) {
      if (!normalized.type.includes('null'))
        normalized.type = [...normalized.type, 'null'];
    } else return { anyOf: [normalized, { type: 'null' }] };
  }

  if (normalized.default === '{}' && normalized.type === 'object')
    normalized.default = {};

  return normalized;
}

/** The key a converted union puts its branches under, or null if it is not one. */
export function branchKey(converted: JsonSchema): 'oneOf' | 'anyOf' | null {
  if (Array.isArray(converted.oneOf)) return 'oneOf';
  if (Array.isArray(converted.anyOf)) return 'anyOf';
  return null;
}

/**
 * Rewrites a converted schema's top-level `required` from the Zod schema itself.
 *
 * Neither `io` setting is right for a request body: `input` drops every key
 * whose field is a `z.preprocess` (its input type admits `undefined`), and
 * `output` marks defaulted keys required. The property shapes stay from the
 * input side; `required` is recomputed per field as "does omitting it fail?",
 * which is exactly `safeParse(undefined)`.
 *
 * `schema` is `unknown` because `ZodUnion#options` is typed as the core
 * `$ZodType[]`, which has neither `safeParse` nor `shape`; the `instanceof`
 * checks are what earn the richer type.
 */
export function withRequiredKeys(
  schema: unknown,
  converted: JsonSchema
): JsonSchema {
  if (schema instanceof z.ZodObject) {
    if (!isJsonSchema(converted.properties)) return converted;

    const required = Object.entries(schema.shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key);

    // OpenAPI 3.1 inherits JSON Schema's rule that `required` is non-empty.
    if (required.length === 0) {
      const { required: _dropped, ...rest } = converted;
      return rest;
    }
    return { ...converted, required };
  }

  // Branch order is assumed to follow `.options` order; the length guard leaves
  // `required` understated rather than attaching one branch's rules to another
  // if a converter ever stops preserving it.
  if (schema instanceof z.ZodUnion) {
    const key = branchKey(converted);
    const branches = key === null ? null : converted[key];
    if (key === null || !Array.isArray(branches)) return converted;
    const options: readonly unknown[] = schema.options;
    if (branches.length !== options.length) return converted;

    return {
      ...converted,
      [key]: branches.map((branch, index) => {
        const option = options[index];
        return option !== undefined && isJsonSchema(branch)
          ? withRequiredKeys(option, branch)
          : branch;
      }),
    };
  }

  return converted;
}
