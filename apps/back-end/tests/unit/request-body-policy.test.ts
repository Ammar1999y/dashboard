/**
 * The two body readers — `lazyFormData` for a multipart route and
 * `readJsonObject` for the gate's JSON parse — and the only place their
 * media-type matching is exercised end to end against the runtime parser.
 *
 * The mixed-case multipart case is version-gated and that is why it is pinned
 * here rather than reasoned about: up to Bun 1.3.14 `Request.formData()` matched
 * `form-data` case-SENSITIVELY and threw on `Multipart/Form-Data`, so a
 * spec-valid request the matcher admitted was refused one layer down. Bun 1.4.0
 * made the parser case-insensitive, and 1.4.0 is the floor `server.ts` asserts —
 * so a regression below that floor breaks a real request, and this is what says
 * so instead of leaving it to be inferred from a comment.
 */
import { describe, expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';

import {
  lazyFormData,
  MAX_JSON_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES,
  readJsonObject,
  SERVER_BODY_LIMIT_BYTES,
} from '@/lib/http/request';

const BOUNDARY = 'X';
const MULTIPART_BODY =
  `--${BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="files"\r\n\r\n' +
  `hello\r\n--${BOUNDARY}--\r\n`;

const multipartRequest = (contentType: string) =>
  new Request('http://localhost/api/upload/file?resource=users', {
    method: 'POST',
    headers: { 'content-type': `${contentType}; boundary=${BOUNDARY}` },
    body: MULTIPART_BODY,
  });

const jsonRequest = (contentType: string, body = JSON.stringify({ a: 1 })) =>
  new Request('http://localhost/api/dash/users', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

const readJson = (request: Request, maxBytes = MAX_JSON_BODY_BYTES) =>
  readJsonObject(request, maxBytes);

/** `readJsonObject`'s refusal, which wraps the problem it answers with. */
const expectRefused = async (promise: Promise<unknown>, status: number) => {
  await expect(promise).rejects.toMatchObject({
    name: 'UnreadableBody',
    refusal: { status },
  });
};

describe('a multipart route accepts every spelling of its media type', () => {
  test.each([
    ['multipart/form-data'],
    ['Multipart/Form-Data'],
    ['MULTIPART/FORM-DATA'],
    ['multipart/form-data '],
  ])('%p parses', async (contentType) => {
    const form = await lazyFormData(multipartRequest(contentType))();

    expect(form).not.toBeNull();
    expect(form?.get('files')).toBe('hello');
  });

  test('another type is not readable as a form, and its body stays unread', async () => {
    const request = jsonRequest('application/json');
    expect(await lazyFormData(request)()).toBeNull();
    expect(request.bodyUsed).toBe(false);
  });

  test('a GET reads nothing', async () => {
    const request = new Request('http://localhost/api/upload/file', {
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    });
    expect(await lazyFormData(request)()).toBeNull();
  });
});

describe('the JSON reader accepts every spelling of its media type', () => {
  test.each([
    ['application/json'],
    ['Application/JSON'],
    ['application/json; charset=utf-8'],
  ])('%p parses', async (contentType) => {
    expect(await readJson(jsonRequest(contentType))).toEqual({ a: 1 });
  });

  test.each([['application/jsonx'], ['text/plain'], ['multipart/form-data']])(
    '%p is refused 400, unread',
    async (contentType) => {
      const request = jsonRequest(contentType);
      await expectRefused(readJson(request), HTTP_STATUS.BAD_REQUEST);
      expect(request.bodyUsed).toBe(false);
    }
  );

  test.each([['{ not json'], [''], ['[1]'], ['null']])(
    '%p is refused 400, not a 500',
    async (body) => {
      await expectRefused(
        readJson(jsonRequest('application/json', body)),
        HTTP_STATUS.BAD_REQUEST
      );
    }
  );
});

describe('a form reads once', () => {
  test('a second read returns the first result rather than throwing', async () => {
    const read = lazyFormData(multipartRequest('multipart/form-data'));

    const first = await read();
    expect(first?.get('files')).toBe('hello');
    // A web `Request` body reads exactly once; without the memoisation this
    // rejects with `Body has already been used`.
    expect(await read()).toBe(first);
  });

  test('a malformed form is null both times, not a throw', async () => {
    const read = lazyFormData(
      new Request('http://localhost/api/upload/file', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        body: 'not a multipart body at all',
      })
    );

    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
  });
});

describe('a JSON route is bounded independently of the server-wide ceiling', () => {
  /**
   * `MAX_REQUEST_BODY_BYTES` is 12 MiB for ONE route shape — a 10 MB document
   * plus multipart framing — and every JSON route used to inherit it, although
   * no JSON schema here admits more than kilobytes. `JSON.parse` is
   * synchronous, so the cost is a stall of the whole process: measured on this
   * runtime, 9.5 MiB of many small keys took 446 ms against 10 ms for the same
   * byte count as one long string. Bounding the JSON reader is what keeps the
   * 12 MiB budget with multipart, where it is actually needed.
   */
  const jsonBody = (bytes: number) =>
    JSON.stringify({ a: 'x'.repeat(Math.max(0, bytes - 8)) });

  const post = (body: BodyInit) =>
    new Request('http://localhost/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  // 413, not the 400 a malformed body produces: a correct document that is
  // merely too big must not be reported as unparseable.
  const expectTooLarge = (promise: Promise<unknown>) =>
    expectRefused(promise, HTTP_STATUS.CONTENT_TOO_LARGE);

  test('a body at the ceiling is still read', async () => {
    const body = jsonBody(MAX_JSON_BODY_BYTES);
    expect(body.length).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES);
    expect(await readJson(post(body))).toBeObject();
  });

  test('a body over the ceiling is 413', async () => {
    await expectTooLarge(readJson(post(jsonBody(MAX_JSON_BODY_BYTES + 4096))));
  });

  test('a route may raise its own ceiling and is still bounded by it', async () => {
    const raised = MAX_JSON_BODY_BYTES * 4;
    expect(await readJson(post(jsonBody(raised - 4096)), raised)).toBeObject();
    await expectTooLarge(readJson(post(jsonBody(raised + 4096)), raised));
  });

  /**
   * The half a `Content-Length` check alone does not cover, and the only half a
   * caller who wants to bypass the ceiling would use: a chunked request
   * declares no length, so the count has to happen while the stream is read.
   */
  test('a chunked body with no Content-Length is bounded too', async () => {
    const bytes = new TextEncoder().encode(jsonBody(MAX_JSON_BODY_BYTES * 4));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 65_536)
          controller.enqueue(bytes.slice(at, at + 65_536));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);

    expect(request.headers.get('content-length')).toBeNull();
    await expectTooLarge(readJson(request));
  });

  test('multipart keeps the 12 MiB budget the JSON cap does not touch', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_JSON_BODY_BYTES).toBeLessThan(MAX_REQUEST_BODY_BYTES);
  });
});

describe('a multipart route is bounded by its own count, not by the server limit', () => {
  /** A chunked multipart body of about `bytes`, declaring no length. */
  const chunkedUpload = (bytes: number) => {
    const head =
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="files"; filename="big.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n';
    const encoded = new TextEncoder().encode(
      `${head}${'y'.repeat(bytes)}\r\n--${BOUNDARY}--\r\n`
    );
    return new Request('http://localhost/api/upload/file?resource=users', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < encoded.length; at += 1024 * 1024)
            controller.enqueue(encoded.slice(at, at + 1024 * 1024));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
  };

  test('a chunked form past the ceiling is 413, not buffered up to the server limit', async () => {
    // Bun's limit now sits above the ceiling so the app can answer a declared
    // over-size body itself; the form reader used to buffer whatever Bun let
    // through.
    const request = chunkedUpload(MAX_REQUEST_BODY_BYTES + 1024 * 1024);
    expect(request.headers.get('content-length')).toBeNull();

    await expect(lazyFormData(request)()).rejects.toMatchObject({
      status: HTTP_STATUS.CONTENT_TOO_LARGE,
    });
  });

  test('a chunked form under the ceiling still parses', async () => {
    const form = await lazyFormData(chunkedUpload(1024))();
    expect(form?.get('files')).toBeInstanceOf(File);
  });

  test('the server limit stays above every ceiling the app answers itself', () => {
    expect(SERVER_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);
  });
});
