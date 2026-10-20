/**
 * The served document is generated once, on the first request, and a failed
 * generation is kept rather than repeated on every authorised request.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import type * as Serve from '@/lib/http/openapi/serve';
import type { OpenApiDocument } from '@app/shared/responses/openapi';

import {
  OPENAPI_VERSION,
  openApiDocumentSchema,
} from '@app/shared/responses/openapi';

const SERVE = path.join(
  import.meta.dir,
  '..',
  '..',
  'lib',
  'http',
  'openapi',
  'serve.ts'
);

/** The source is module state: a distinct query string loads a separate instance. */
async function freshServe(instance: string): Promise<typeof Serve> {
  /* eslint-disable-next-line no-unsanitized/method -- this file's own path;
     the query only names the instance */
  return (await import(`${SERVE}?${instance}`)) as typeof Serve;
}

const emptyDocument = (): OpenApiDocument => ({
  openapi: OPENAPI_VERSION,
  info: {},
  servers: [],
  tags: [],
  components: {},
  paths: {},
});

describe('the served document', () => {
  test('is generated on the first request, then the same for every later one', async () => {
    const serve = await freshServe('once');
    let calls = 0;
    serve.provideDocument(async () => {
      calls++;
      return emptyDocument();
    });
    expect(calls).toBe(0);

    const first = serve.servedDocument();
    for (let i = 0; i < 5; i++) expect(serve.servedDocument()).toBe(first);
    expect(await serve.servedDocument()).toBe(await first);
    expect(calls).toBe(1);
  });

  test('a failed generation is kept and rethrown rather than retried', async () => {
    const serve = await freshServe('failure');
    let calls = 0;
    serve.provideDocument(async () => {
      calls++;
      throw new Error('conversion failed');
    });

    const failures: string[] = [];
    for (let i = 0; i < 3; i++)
      await serve.servedDocument().catch((error: unknown) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });

    expect(calls).toBe(1);
    expect(failures).toEqual([
      'conversion failed',
      'conversion failed',
      'conversion failed',
    ]);
  });

  test('its body is serialised once, as a value answer would carry it', async () => {
    const serve = await freshServe('body');
    let calls = 0;
    serve.provideDocument(async () => {
      calls++;
      return emptyDocument();
    });

    const first = serve.servedDocumentBody();
    for (let i = 0; i < 5; i++) expect(serve.servedDocumentBody()).toBe(first);
    const body = await first;
    expect(body.text).toBe(
      JSON.stringify(openApiDocumentSchema.parse(emptyDocument()))
    );
    expect(calls).toBe(1);
  });

  test('can be generated ahead of any request, which then reuses it', async () => {
    const serve = await freshServe('prepare');
    let calls = 0;
    serve.provideDocument(async () => {
      calls++;
      return emptyDocument();
    });
    const logged = spyOn(console, 'log').mockImplementation(() => {});
    try {
      serve.prepareServedDocument();
      expect(calls).toBe(1);
      await serve.servedDocumentBody();
      expect(calls).toBe(1);
      expect(String(logged.mock.calls.at(-1)?.[0])).toContain(
        '"msg":"openapi document prepared"'
      );
    } finally {
      logged.mockRestore();
    }
  });

  test('a generation ahead of any request that fails is logged by class', async () => {
    const serve = await freshServe('prepare-failure');
    serve.provideDocument(async () => {
      throw new TypeError('conversion failed');
    });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      serve.prepareServedDocument();
      await serve.servedDocumentBody().catch(() => {});
      expect(logged.mock.calls.map(([line]) => String(line))).toEqual([
        JSON.stringify({
          msg: 'openapi document generation failed',
          errorClass: 'TypeError',
        }),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  test('refuses a second source, and a request before any source', async () => {
    const serve = await freshServe('sources');
    expect(() => serve.servedDocument()).toThrow(
      'Nothing provides the served OpenAPI document.'
    );
    serve.provideDocument(async () => emptyDocument());
    expect(() => {
      serve.provideDocument(async () => emptyDocument());
    }).toThrow('The served OpenAPI document already has a source.');
  });
});
