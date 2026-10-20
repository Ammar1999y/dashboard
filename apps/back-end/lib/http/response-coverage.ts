/**
 * Which answers came back within the contract: each endpoint and each of our
 * Better Auth plugin endpoints, and each member of a union answer. Each
 * process appends its first sightings to a file of its own under
 * `RESPONSE_CONTRACT_COVERAGE_DIR`, so a test's child processes count too;
 * `tests/helpers/run.ts` totals them after a tier.
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AnyEndpoint } from '@app/shared/api/endpoint';

import * as z from 'zod';

import { ENDPOINTS, PLUGIN_ENDPOINTS } from '@app/shared/api/all';
import { isPagedResponse, isRawResponse } from '@app/shared/api/endpoint';

import {
  REDIRECTING_PLUGIN_PATHS,
  TWO_FACTOR_CHALLENGE_PATHS,
} from './openapi/better-auth-tables';

/** Where a schema's union sits: the whole body, or its `data`. */
interface UnionSite {
  members: readonly z.core.$ZodType[];
  /** The part of an answer the members are matched against. */
  pick: (answer: unknown) => unknown;
}

const NO_UNION: UnionSite = { members: [], pick: (answer) => answer };

const dataOf = (answer: unknown): unknown =>
  typeof answer === 'object' && answer !== null && 'data' in answer
    ? answer.data
    : undefined;

function unionOf(schema: z.core.$ZodType): UnionSite {
  if (schema instanceof z.ZodUnion)
    return { members: schema.options, pick: (answer) => answer };
  if (schema instanceof z.ZodObject) {
    const data: unknown = schema.shape.data;
    if (data instanceof z.ZodUnion)
      return { members: data.options, pick: dataOf };
  }
  return NO_UNION;
}

const keyOf = ({ method, path }: AnyEndpoint) => `${method} ${path}`;

/** An endpoint's union is its `data` schema; a raw answer has none to count. */
const entryUnion = ({ response }: AnyEndpoint): UnionSite => {
  if (isRawResponse(response)) return NO_UNION;
  const data = isPagedResponse(response) ? response.data : response;
  return data instanceof z.ZodUnion
    ? { members: data.options, pick: dataOf }
    : NO_UNION;
};

/** Every endpoint with an answer of its own to hold, by its key. */
const ANSWERING = new Map(
  ENDPOINTS.filter(({ response }) => !isRawResponse(response)).map(
    (entry) => [keyOf(entry), entry] as const
  )
);

const pluginUnion = (route: string): UnionSite => {
  const entry = PLUGIN_ENDPOINTS.get(route);
  return entry ? unionOf(entry.response.raw) : NO_UNION;
};

/** How a plugin endpoint is named in a report: its path under the prefix. */
export const pluginCoverageName = (route: string): string =>
  `Better Auth ${route}`;

const memberId = (name: string, member?: number): string =>
  member === undefined ? name : `${name} #${member}`;

/** The redirect a redirecting plugin endpoint answers in place of a body. */
export const redirectCoverageId = (route: string): string =>
  `${pluginCoverageName(route)} 302`;

/** A two-factor challenge answered by one of the library's own paths. */
export const challengeCoverageId = (route: string): string =>
  `${pluginCoverageName(route)} challenge`;

const idsOf = (name: string, site: UnionSite): string[] =>
  site.members.length === 0
    ? [memberId(name)]
    : site.members.map((_, index) => memberId(name, index));

/** What a run that reached every answer would have recorded. */
export function expectedResponseCoverage(): string[] {
  return [
    ...[...ANSWERING].flatMap(([key, entry]) => idsOf(key, entryUnion(entry))),
    ...PLUGIN_ENDPOINTS.keys().flatMap((route) =>
      idsOf(pluginCoverageName(route), pluginUnion(route))
    ),
    ...REDIRECTING_PLUGIN_PATHS.map((route) => redirectCoverageId(route)),
    ...[...TWO_FACTOR_CHALLENGE_PATHS].map((route) =>
      challengeCoverageId(route)
    ),
  ];
}

const PLUGIN_NAME = /^Better Auth (\/\S+)$/;

/** The union a named answer belongs to, for describing `NAME #n` in a report. */
function siteOf(name: string): UnionSite {
  const entry = ANSWERING.get(name);
  if (entry) return entryUnion(entry);
  const route = PLUGIN_NAME.exec(name)?.[1];
  return route === undefined ? NO_UNION : pluginUnion(route);
}

/** The keys of a union member, which say what `NAME #n` is in a report. */
export function describeResponseCoverage(id: string): string {
  const [name, member] = id.split(' #', 2);
  if (name === undefined || member === undefined) return id;
  const option = siteOf(name).members[Number(member)];
  return option instanceof z.ZodObject
    ? `${id} {${Object.keys(option.shape).join(', ')}}`
    : id;
}

const matchingMember = (
  site: UnionSite,
  answer: unknown
): number | undefined => {
  if (site.members.length === 0) return undefined;
  const picked = site.pick(answer);
  return site.members.findIndex(
    (member) => z.safeParse(member, picked).success
  );
};

/** The id an endpoint's answer counts for; `body` as it went on the wire. */
export const responseCoverageId = (entry: AnyEndpoint, body: unknown): string =>
  memberId(keyOf(entry), matchingMember(entryUnion(entry), body));

/** The id a plugin endpoint's 2xx body counts for. */
export const pluginCoverageId = (route: string, body: unknown): string =>
  memberId(pluginCoverageName(route), matchingMember(pluginUnion(route), body));

const sighted = new Set<string>();

export function recordResponseCoverage(id: string): void {
  const dir = process.env.RESPONSE_CONTRACT_COVERAGE_DIR;
  if (!dir || sighted.has(id)) return;
  sighted.add(id);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory the test runner created for this run
  appendFileSync(
    path.join(dir, `${process.pid}.jsonl`),
    `${JSON.stringify(id)}\n`
  );
}

/** Every id the processes of one run recorded under `dir`. */
export function readResponseCoverage(dir: string): Set<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the directory the runner created for this run
  const files = readdirSync(dir).map((name) => path.join(dir, name));
  const ids = files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file a process of this run wrote there
    .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
  return new Set(ids.filter((id) => typeof id === 'string'));
}
