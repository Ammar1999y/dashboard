/**
 * Every answer the application gives, held to the document it serves at
 * `GET /openapi.json`: the status must be one the operation publishes, a body
 * one of its published media types, and a JSON body must match the published
 * schema. The runtime check (`lib/http/response-check.ts`) holds answers to
 * the shared schemas the document is generated from; this holds the generated
 * document itself, the Better Auth merge included, to what is really sent.
 *
 * A request no operation describes is out of the document's reach, so only
 * its refusals pass: a success there is an undocumented route, unless its path
 * is one the caller names as deliberately left out.
 */
import type { JsonSchema } from '@/lib/http/openapi/json-schema';
import type { OpenApiDocument } from '@app/shared/responses/openapi';

import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020';

import { isJsonSchema } from '@/lib/http/openapi/json-schema';
import { isRoutableHost } from '@/lib/http/routing';

const DOCUMENT_ID = 'openapi.json';

/** How many schema errors one mismatch names. */
const ERRORS_SHOWN = 4;

interface Operation {
  name: string;
  /** The operation's JSON Pointer inside the document. */
  pointer: string;
  responses: JsonSchema;
}

interface PathTemplate {
  template: string;
  pattern: RegExp;
  item: JsonSchema;
}

const escapeRegExp = (text: string) =>
  text.replaceAll(/[$()*+.?[\\\]^|{}]/g, String.raw`\$&`);

/** A JSON Pointer segment, URI-encoded for a `$ref` fragment. */
const pointerSegment = (segment: string) =>
  encodeURIComponent(segment.replaceAll('~', '~0').replaceAll('/', '~1'));

const isSuccess = (status: number) => status >= 200 && status < 300;

const isJsonMediaType = (mediaType: string) =>
  mediaType === 'application/json' || mediaType.endsWith('+json');

/** Templates with fewer parameters first: a static segment wins, as it does in the router. */
function pathTemplates(document: OpenApiDocument): PathTemplate[] {
  return Object.entries(document.paths)
    .filter((entry): entry is [string, JsonSchema] => isJsonSchema(entry[1]))
    .map(([template, item]) => ({
      template,
      // eslint-disable-next-line security/detect-non-literal-regexp -- the document's own paths, each piece escaped
      pattern: new RegExp(
        `^${template
          .split(/\{[^}]+\}/)
          .map(escapeRegExp)
          .join('[^/]+')}$`
      ),
      item,
      parameters: template.split('{').length - 1,
    }))
    .toSorted((a, b) => a.parameters - b.parameters);
}

/** A body as sent, and its JSON when it parses as such. */
type Sent = { text: string } & (
  { parsed: true; json: unknown } | { parsed: false }
);

function sentBody(text: string): Sent {
  try {
    return { text, parsed: true, json: JSON.parse(text) };
  } catch {
    return { text, parsed: false };
  }
}

export type DocumentCheck = (
  request: Request,
  response: Response
) => Promise<string[]>;

/** What is wrong with each answer against `document`; empty when it is described. */
export function documentCheck(
  document: OpenApiDocument,
  undocumentedPaths: readonly string[] = []
): DocumentCheck {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(document, DOCUMENT_ID);
  const templates = pathTemplates(document);

  function operationOf(method: string, pathname: string): Operation | null {
    for (const { template, pattern, item } of templates) {
      const operation = item[method];
      if (!pattern.test(pathname) || !isJsonSchema(operation)) continue;
      return {
        name: `${method.toUpperCase()} ${template}`,
        pointer: `#/paths/${pointerSegment(template)}/${method}`,
        responses: isJsonSchema(operation.responses) ? operation.responses : {},
      };
    }
    return null;
  }

  function schemaProblems(
    operation: Operation,
    status: string,
    mediaType: string,
    body: unknown
  ): string[] {
    const validate = ajv.getSchema(
      `${DOCUMENT_ID}${operation.pointer}/responses/${status}/content/${pointerSegment(mediaType)}/schema`
    );
    if (!validate) return ['the document publishes no schema for it'];
    if (validate(body)) return [];
    return (validate.errors ?? [])
      .slice(0, ERRORS_SHOWN)
      .map(
        (error) =>
          `${error.instancePath || 'body'} ${error.message ?? error.keyword}`
      );
  }

  function bodyProblems(
    operation: Operation,
    status: string,
    published: JsonSchema,
    mediaType: string,
    sent: Sent
  ): string[] {
    if (sent.text === '') return [];
    const content = isJsonSchema(published.content) ? published.content : {};
    if (!mediaType || !Object.hasOwn(content, mediaType))
      return [
        `a ${mediaType || 'untyped'} body, where the document publishes ${Object.keys(content).join(', ') || 'none'}`,
      ];
    if (!isJsonMediaType(mediaType)) return [];
    if (!sent.parsed) return [`a body that is not ${mediaType}`];
    return schemaProblems(operation, status, mediaType, sent.json);
  }

  return async (request, response) => {
    // The CORS layer's, which the document leaves out.
    if (request.method === 'OPTIONS') return [];
    const url = URL.parse(request.url);
    if (!url || !isRoutableHost(url)) return [];
    // A HEAD is its GET's answer, seen here before the exit step drops the body.
    const method =
      request.method === 'HEAD' ? 'get' : request.method.toLowerCase();
    const operation = operationOf(method, url.pathname);
    const status = String(response.status);
    if (!operation)
      return isSuccess(response.status) &&
        !undocumentedPaths.includes(url.pathname)
        ? [
            `${request.method} ${url.pathname} ${status}: answered, but no operation in the document describes it`,
          ]
        : [];
    const mediaType =
      (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase() ?? '';
    const sent = sentBody(await response.clone().text());
    const published = operation.responses[status];
    const problems = isJsonSchema(published)
      ? bodyProblems(operation, status, published, mediaType, sent)
      : ['the operation does not publish this status'];
    const code =
      sent.parsed &&
      isJsonSchema(sent.json) &&
      typeof sent.json.code === 'string'
        ? ` (code ${sent.json.code})`
        : '';
    return problems.map(
      (problem) => `${operation.name} ${status}${code}: ${problem}`
    );
  };
}

/**
 * Every operation the document publishes under `prefix`, asked once with
 * `headers` and an empty JSON object as any body, and each answer judged by
 * `check`. GETs go first and `/sign-out` last, so a session in `headers`
 * stays live for the rest.
 */
export async function askEveryOperation(
  document: OpenApiDocument,
  prefix: string,
  handle: (request: Request) => Promise<Response>,
  headers: Record<string, string>
): Promise<string[]> {
  const operations = Object.entries(document.paths)
    .filter(([path, item]) => path.startsWith(prefix) && isJsonSchema(item))
    .flatMap(([path, item]) =>
      Object.keys(isJsonSchema(item) ? item : {}).map((method) => ({
        path,
        method: method.toUpperCase(),
      }))
    )
    .toSorted(
      (a, b) =>
        Number(a.path.endsWith('/sign-out')) -
          Number(b.path.endsWith('/sign-out')) ||
        Number(a.method !== 'GET') - Number(b.method !== 'GET')
    );
  const check = documentCheck(document);
  const problems: string[] = [];
  for (const { path, method } of operations) {
    const request = new Request(`http://localhost${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(method !== 'GET' && { body: '{}' }),
    });
    problems.push(...(await check(request.clone(), await handle(request))));
  }
  return problems;
}
