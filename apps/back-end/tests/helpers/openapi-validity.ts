/**
 * The two validators the generated document is held to, so the unit tier and
 * every row of the configuration matrix ask the same question.
 */
import type { JsonSchema } from '@/lib/http/openapi/json-schema';

import SwaggerParser from '@apidevtools/swagger-parser';
import { createConfig, lintFromString } from '@redocly/openapi-core';

/** Rejects with swagger-parser's own error. It dereferences in place, hence the copy. */
export async function validateWithSwaggerParser(
  document: JsonSchema
): Promise<void> {
  await SwaggerParser.validate(structuredClone(document) as never);
}

/** Every problem Redocly's `minimal` ruleset reports, warnings included. */
export async function redoclyProblems(document: JsonSchema): Promise<string[]> {
  const problems = await lintFromString({
    source: JSON.stringify(document),
    absoluteRef: 'openapi.json',
    config: await createConfig({ extends: ['minimal'] }),
  });
  return problems.map((problem) => `${problem.ruleId}: ${problem.message}`);
}
