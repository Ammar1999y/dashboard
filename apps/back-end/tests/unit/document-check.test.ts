/**
 * The guard that holds every in-process answer of the database tiers to the
 * served document (`tests/helpers/document-check.ts`). What it refuses has to
 * be refused here first, or a green tier says nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { OpenApiDocument } from '@app/shared/responses/openapi';

import { OPENAPI_VERSION } from '@app/shared/responses/openapi';

import { documentCheck } from '../helpers/document-check';

const json = (schema: unknown) => ({
  content: { 'application/json': { schema } },
});

const DOCUMENT: OpenApiDocument = {
  openapi: OPENAPI_VERSION,
  info: {},
  servers: [],
  tags: [],
  components: {
    schemas: {
      Thing: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  paths: {
    '/api/things/{id}': {
      get: {
        responses: {
          '200': {
            description: 'A thing.',
            ...json({ $ref: '#/components/schemas/Thing' }),
          },
          '302': { description: 'Elsewhere.' },
          '404': { description: 'Missing.', content: { 'text/plain': {} } },
          '409': {
            description: 'No schema.',
            content: { 'application/json': {} },
          },
        },
      },
    },
    '/api/things/mine': {
      put: { responses: { '204': { description: 'Saved.' } } },
    },
  },
};

const check = documentCheck(DOCUMENT, ['/reference']);

const ask = (
  url: string,
  response: Response,
  method = 'GET'
): Promise<string[]> =>
  check(new Request(`http://localhost${url}`, { method }), response);

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('an answer the document describes', () => {
  test('passes, its schema resolved through the components', async () => {
    expect(await ask(`/api/things/${ID}`, Response.json({ id: ID }))).toEqual(
      []
    );
  });

  test('passes bodiless, or in a published media type it cannot read', async () => {
    expect(
      await ask('/api/things/x', new Response(null, { status: 302 }))
    ).toEqual([]);
    expect(
      await ask(
        '/api/things/x',
        new Response('gone', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      )
    ).toEqual([]);
  });

  test('a HEAD is judged as its GET', async () => {
    expect(
      await ask(`/api/things/${ID}`, Response.json({ id: 'x' }), 'HEAD')
    ).toEqual(['GET /api/things/{id} 200: /id must match format "uuid"']);
  });

  test('a static segment wins over a parameter, as in the router', async () => {
    expect(
      await ask('/api/things/mine', new Response(null, { status: 204 }), 'PUT')
    ).toEqual([]);
  });
});

describe('an answer the document cannot describe fails', () => {
  test('an unpublished status, naming the code it carried', async () => {
    expect(
      await ask(
        '/api/things/x',
        Response.json({ message: 'no', code: 'NOPE' }, { status: 401 })
      )
    ).toEqual([
      'GET /api/things/{id} 401 (code NOPE): the operation does not publish this status',
    ]);
  });

  test('a body breaking the schema', async () => {
    expect(
      await ask('/api/things/x', Response.json({ id: ID, extra: true }))
    ).toEqual([
      'GET /api/things/{id} 200: body must NOT have additional properties',
    ]);
  });

  test('a body where none, or another media type, is published', async () => {
    expect(
      await ask('/api/things/x', Response.json({}, { status: 302 }))
    ).toEqual([
      'GET /api/things/{id} 302: a application/json body, where the document publishes none',
    ]);
    expect(
      await ask('/api/things/x', Response.json({}, { status: 404 }))
    ).toEqual([
      'GET /api/things/{id} 404: a application/json body, where the document publishes text/plain',
    ]);
  });

  test('a JSON body whose status publishes no schema, or that is not JSON', async () => {
    expect(
      await ask('/api/things/x', Response.json({}, { status: 409 }))
    ).toEqual([
      'GET /api/things/{id} 409: the document publishes no schema for it',
    ]);
    expect(
      await ask(
        '/api/things/x',
        new Response('{', { headers: { 'content-type': 'application/json' } })
      )
    ).toEqual([
      'GET /api/things/{id} 200: a body that is not application/json',
    ]);
  });

  test('a success no operation describes', async () => {
    expect(await ask('/api/elsewhere', Response.json({}))).toEqual([
      'GET /api/elsewhere 200: answered, but no operation in the document describes it',
    ]);
    expect(
      await ask('/api/things/x', Response.json({}), 'DELETE')
    ).toHaveLength(1);
  });
});

describe('what is outside the document passes', () => {
  test('a refusal of a request no operation describes', async () => {
    expect(
      await ask('/api/elsewhere', Response.json({}, { status: 404 }))
    ).toEqual([]);
    expect(
      await ask('/api/things/x', Response.json({}, { status: 405 }), 'DELETE')
    ).toEqual([]);
  });

  test('a path named as left out, a preflight, and an unroutable host', async () => {
    expect(await ask('/reference', new Response('<html>'))).toEqual([]);
    expect(
      await ask('/api/things/x', new Response(null, { status: 204 }), 'OPTIONS')
    ).toEqual([]);
    expect(
      await check(
        new Request(`http://abc/api/things/${ID}`),
        Response.json({}, { status: 404 })
      )
    ).toEqual([]);
  });
});
