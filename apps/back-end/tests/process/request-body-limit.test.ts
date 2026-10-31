/**
 * A declared over-size upload against a real listener: `app.handle()` skips
 * Bun's own `maxRequestBodySize`, which is the layer that used to answer these.
 * At the app's ceiling, Bun refused before any hook ran, with no CORS header and
 * no problem body, so a cross-origin dashboard saw a network error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';

import { app } from '@/app';

import { PROBLEM_MEDIA_TYPE } from '@app/shared/api/wire';
import { HTTP_STATUS } from '@app/shared/http-status';

import { PUBLIC_ORIGIN } from '@/lib/env';
import {
  MAX_REQUEST_BODY_BYTES,
  SERVER_BODY_LIMIT_BYTES,
} from '@/lib/http/request';

const state = { port: 0 };

beforeAll(() => {
  app.listen({ port: 0 });
  const server = app.server;
  if (!server) throw new Error('test listener did not start');
  state.port = server.port ?? 0;
});

afterAll(async () => {
  await app.stop();
});

/**
 * The response head to an upload declaring `declared` bytes, written raw so
 * the body keeps streaming as a browser's would while the answer arrives.
 */
function uploadHead(declared: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(state.port, '127.0.0.1');
    let received = '';
    let sent = 0;
    const settle = () => {
      socket.destroy();
      resolve(received.split('\r\n\r\n', 1)[0] ?? '');
    };
    socket.on('data', (data) => {
      received += data.toString();
      if (received.includes('\r\n\r\n')) settle();
    });
    socket.on('close', settle);
    socket.on('error', () => {});
    socket.write(
      `POST /api/upload/file?resource=users HTTP/1.1\r\nHost: localhost\r\n` +
        `Origin: ${PUBLIC_ORIGIN}\r\ncf-connecting-ip: 203.0.113.9\r\n` +
        `Content-Type: multipart/form-data; boundary=X\r\n` +
        `Content-Length: ${declared}\r\n\r\n`
    );
    const chunk = Buffer.alloc(64 * 1024, 120);
    const pump = () => {
      while (sent < declared && !socket.destroyed) {
        sent += chunk.length;
        if (!socket.write(chunk)) {
          socket.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
}

describe('a declared over-size upload', () => {
  test.each([
    ['just past the ceiling', MAX_REQUEST_BODY_BYTES + 10],
    ['a few megabytes past it', 15 * 1000 * 1000],
  ])(
    '%s gets the documented 413 with CORS, from the app rather than the server',
    async (_, declared) => {
      expect(declared).toBeLessThan(SERVER_BODY_LIMIT_BYTES);
      const raw = await uploadHead(declared);
      const head = raw.toLowerCase().split('\r\n');

      expect(head[0]).toStartWith(`http/1.1 ${HTTP_STATUS.CONTENT_TOO_LARGE}`);
      expect(head).toContain(
        `access-control-allow-origin: ${PUBLIC_ORIGIN.toLowerCase()}`
      );
      expect(head).toContain(`content-type: ${PROBLEM_MEDIA_TYPE}`);
    },
    30_000
  );
});
