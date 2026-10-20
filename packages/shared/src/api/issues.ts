/**
 * Where a body breaks an endpoint's published success; for tests and mock
 * mode, never production, since it builds each schema's JSON Schema at first
 * use.
 */
import type { EndpointDefinition } from './endpoint';

import * as z from 'zod';

import { twoFactorChallengeSchema } from '../responses/better-auth';
import { successSchemaOf } from './wire';

/** Where a body breaks the contract: paths and codes, never values. */
export interface ResponseIssue {
  path: PropertyKey[];
  code: string;
}

/**
 * A union reports one `invalid_union` at its own path whatever went wrong
 * inside it, so this descends into the branch that came closest: the one with
 * the fewest issues.
 */
function closestIssues(issue: z.core.$ZodIssue): ResponseIssue[] {
  if (issue.code !== 'invalid_union' || issue.errors.length === 0)
    return [{ path: issue.path, code: issue.code }];
  const closest = issue.errors.reduce((best, branch) =>
    branch.length < best.length ? branch : best
  );
  return closest.flatMap((nested) =>
    closestIssues(nested).map(({ path, code }) => ({
      path: [...issue.path, ...path],
      code,
    }))
  );
}

const builtChecks = new WeakMap<z.ZodType, readonly z.ZodType[]>();

/** The shared parse, then its own JSON Schema read back; built once per schema. */
function checksOf(schema: z.ZodType): readonly z.ZodType[] {
  let checks = builtChecks.get(schema);
  if (!checks) {
    checks = [
      schema,
      z.fromJSONSchema(z.toJSONSchema(schema, { io: 'output' })),
    ];
    builtChecks.set(schema, checks);
  }
  return checks;
}

/**
 * Where `body` breaks `schema`'s published contract. The shared parse catches
 * refinements, and its own JSON Schema read back catches what the document
 * states beyond them: an unnamed key at any depth, formats, metadata-only
 * keywords, `uniqueItems`, and a body matching two `oneOf` branches.
 */
function contractIssues(schema: z.ZodType, body: unknown): ResponseIssue[] {
  const seen = new Set<string>();
  return checksOf(schema)
    .flatMap((check) => {
      const result = check.safeParse(body);
      return result.success ? [] : result.error.issues.flatMap(closestIssues);
    })
    .filter(({ path, code }) => {
      const id = JSON.stringify([path.map(String), code]);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

const entrySchemas = new WeakMap<object, z.ZodType>();

/** Where `body` breaks the published success of `entry`. */
export function endpointIssues(
  entry: Pick<EndpointDefinition, 'response'>,
  body: unknown
): ResponseIssue[] {
  let schema = entrySchemas.get(entry);
  if (!schema) {
    schema = successSchemaOf(entry);
    entrySchemas.set(entry, schema);
  }
  return contractIssues(schema, body);
}

/**
 * Where a two-factor challenge breaks its schema, wherever it is answered:
 * this project's hook sends it from the library's own `/sign-in/email` too.
 */
export const twoFactorChallengeIssues = (body: unknown): ResponseIssue[] =>
  contractIssues(twoFactorChallengeSchema, body);
