/**
 * The served document is generated once, on the first request, and a failed
 * generation is kept rather than repeated on every authorised request.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import type * as Serve from '@/lib/http/openapi/serve';
import type { OpenApiDocument } from '@app/shared/responses/openapi';

import { OPENAPI_VERSION } from '@app/shared/responses/openapi';

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
