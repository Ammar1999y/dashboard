/**
 * The two body readers — `lazyFormData` for a multipart route and
 * `readJsonObject` for the gate's JSON parse — exercised end to end against
 * the runtime parsers they hand the body to.
 */
import { describe, expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';

import {
  lazyFormData,
  MAX_JSON_BODY_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_REQUEST_BODY_BYTES,
  readJsonObject,
  readWithin,
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

describe('a form is refused past its part ceiling while it streams', () => {
  const part = (name: string, value = '') =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const form = (parts: number) =>
    Array.from({ length: parts }, (_, i) => part(`f${i}`)).join('') +
    `--${BOUNDARY}--\r\n`;

  /** `text` in `size`-byte chunks, recording how many the reader pulled. */
  const streamed = (text: string, size: number) => {
    const bytes = new TextEncoder().encode(text);
    const pulled = { chunks: 0, of: Math.ceil(bytes.length / size) };
    let at = 0;
    const request = new Request('http://localhost/api/upload/file', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.length) return controller.close();
          pulled.chunks += 1;
          controller.enqueue(bytes.slice(at, (at += size)));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    return { request, pulled };
  };

  const expectRefused400 = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({
      status: HTTP_STATUS.BAD_REQUEST,
    });

  test('a form at the ceiling parses', async () => {
    const { request } = streamed(form(MAX_MULTIPART_PARTS), 1024);
    const parsed = await lazyFormData(request)();
    expect([...(parsed ?? [])]).toHaveLength(MAX_MULTIPART_PARTS);
  });

  test('one part past it is 400', async () => {
    const { request } = streamed(form(MAX_MULTIPART_PARTS + 1), 1024);
    await expectRefused400(lazyFormData(request)());
  });

  test('a flood of empty parts stops the upload instead of reading it to the end', async () => {
    const { request, pulled } = streamed(form(100_000), 64 * 1024);
    await expectRefused400(lazyFormData(request)());
    // The refusing chunk and the one the pipe had already pulled ahead.
    expect(pulled.chunks).toBeLessThanOrEqual(2);
    expect(pulled.of).toBeGreaterThan(50);
  });

  // One byte a chunk cuts every opening, which only the carry counts.
  test('an opening cut across chunks still counts', async () => {
    const { request } = streamed(form(MAX_MULTIPART_PARTS + 1), 1);
    await expectRefused400(lazyFormData(request)());
  });

  // Bun opens a part at `--boundary` + CRLF whether a CRLF precedes it or not,
  // so a count of CRLF-led openings alone would be one a flood could walk past.
  test('an opening with no CRLF before it counts, as the parser splits on it', async () => {
    const glued = Array.from(
      { length: MAX_MULTIPART_PARTS + 1 },
      (_, i) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\nv`
    ).join('');
    const { request } = streamed(`${glued}--${BOUNDARY}--\r\n`, 1024);
    await expectRefused400(lazyFormData(request)());
  });

  test('a file carrying the boundary text more often than the ceiling still parses as one', async () => {
    const svg = `<svg><text>${`--${BOUNDARY}z`.repeat(MAX_MULTIPART_PARTS * 2)}</text></svg>`;
    const { request } = streamed(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="a.svg"\r\n` +
        `Content-Type: image/svg+xml\r\n\r\n${svg}\r\n--${BOUNDARY}--\r\n`,
      1024
    );
    const parsed = await lazyFormData(request)();
    expect([...(parsed ?? [])]).toHaveLength(1);
    expect(await (parsed?.get('files') as File).text()).toBe(svg);
  });

  const headed = (contentType: string, body: string) =>
    new Request('http://localhost/api/upload/file', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });

  test('a quoted boundary is the one counted', async () => {
    const request = headed(
      `multipart/form-data; boundary="${BOUNDARY}"`,
      form(MAX_MULTIPART_PARTS + 1)
    );
    await expectRefused400(lazyFormData(request)());
  });

  /**
   * `Request.formData()` reads the body as URL-encoded pairs when the media
   * type appears anywhere in the header, the boundary included: 100,000 pairs
   * from 300 KB, with no multipart opening for the count to see.
   */
  test.each([
    ['multipart/form-data; boundary=application/x-www-form-urlencoded'],
    [
      `multipart/form-data; boundary=${BOUNDARY}; note=application/x-www-form-urlencoded`,
    ],
  ])('%p is never parsed as URL-encoded pairs', async (type) => {
    expect(
      await lazyFormData(headed(type, 'x=&'.repeat(100_000)))()
    ).toBeNull();
  });

  test('a boundary spelling the URL-encoded type still bounds a real form', async () => {
    const boundary = 'application/x-www-form-urlencoded';
    const request = headed(
      `multipart/form-data; boundary=${boundary}`,
      form(MAX_MULTIPART_PARTS + 1).replaceAll(
        `--${BOUNDARY}`,
        () => `--${boundary}`
      )
    );
    await expectRefused400(lazyFormData(request)());
  });

  test.each([
    [`multipart/form-data; boundary=${BOUNDARY}; boundary=other`],
    [`multipart/form-data; xboundary=other; boundary=${BOUNDARY}`],
    [`multipart/form-data; note="boundary=other"; boundary=${BOUNDARY}`],
    [`multipart/form-data; note="a;b"; boundary=${BOUNDARY}`],
    [`multipart/form-data; charset=utf-8; boundary="${BOUNDARY}"`],
    [`multipart/form-data; boundary=${BOUNDARY} ; charset=utf-8`],
    [`multipart/form-data;boundary=${BOUNDARY}`],
    [`multipart/form-data; boundary=${BOUNDARY};`],
    [`multipart/form-data;; boundary=${BOUNDARY}`],
    [`multipart/form-data; note="a\\\\b"; boundary=${BOUNDARY}`],
    [`multipart/form-data; boundary="\\${BOUNDARY}"`],
  ])('%p names its boundary and parses', async (type) => {
    const parsed = await lazyFormData(headed(type, MULTIPART_BODY))();
    expect(parsed?.get('files')).toBe('hello');
  });

  test('an all-hyphen boundary reaches the ceiling one part early, never late', async () => {
    const hyphens = (parts: number) =>
      headed(
        'multipart/form-data; boundary=-',
        form(parts).replaceAll(`--${BOUNDARY}`, '---')
      );
    const parsed = await lazyFormData(hyphens(MAX_MULTIPART_PARTS - 1))();
    expect([...(parsed ?? [])]).toHaveLength(MAX_MULTIPART_PARTS - 1);
    await expectRefused400(lazyFormData(hyphens(MAX_MULTIPART_PARTS))());
  });

  test('a quoted boundary with a space inside parses, as RFC 2046 allows', async () => {
    const parsed = await lazyFormData(
      headed(
        'multipart/form-data; boundary="a b"',
        MULTIPART_BODY.replaceAll(`--${BOUNDARY}`, '--a b')
      )
    )();
    expect(parsed?.get('files')).toBe('hello');
  });

  test.each([
    ['multipart/form-data'],
    ['multipart/form-data; boundary='],
    ['multipart/form-data; boundary=""'],
    [`multipart/form-data; boundary= ${BOUNDARY}`],
    [`multipart/form-data; boundary="${BOUNDARY}"x`],
    [`multipart/form-data; boundary="${BOUNDARY}\\"x"`],
    ['multipart/form-data; boundary="a "'],
    ['multipart/form-data; boundary="a'],
    [`multipart/form-data; flag; boundary=${BOUNDARY}`],
    ['multipart/form-data; boundary=abé'],
  ])('%p names no usable boundary, so it is no form, unread', async (type) => {
    const request = headed(type, MULTIPART_BODY);
    expect(await lazyFormData(request)()).toBeNull();
    expect(request.bodyUsed).toBe(false);
  });
});

describe('readWithin', () => {
  const late = () => new Error('late');

  test('answers the read when it settles first', async () => {
    expect(await readWithin(Promise.resolve('body'), 1000, late)).toBe('body');
  });

  test('answers the refusal once the deadline passes first, and leaves the read unawaited', async () => {
    const read = Promise.withResolvers<string>();
    const started = Date.now();
    await expect(readWithin(read.promise, 20, late)).rejects.toThrow('late');
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    // A read failing after the deadline answered is not an unhandled rejection.
    read.reject(new Error('stream reset'));
    await Bun.sleep(5);
  });
});
