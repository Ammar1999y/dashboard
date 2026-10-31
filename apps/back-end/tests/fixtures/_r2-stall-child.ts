/**
 * Subprocess body for `r2-deadline.test.ts`: the REAL S3 client against an
 * object store that sends a response's headers and then stalls its body. Every
 * tier's preload replaces the client, and nothing else reaches the handler's
 * timers. Run with `bun --no-env-file` and throwaway R2 variables.
 *
 * Every HTTPS request the SDK opens is sent to a local socket instead; the SDK
 * reads `node:https`'s `request` when it sends, so the swap needs no hook in
 * the client. Prints ONE line of JSON.
 */
import http from 'node:http';
import https from 'node:https';

const store = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket) {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: 4096\r\n\r\n<?xml version="1.0"'
      );
    },
  },
});

Object.assign(https, {
  request: (options: http.RequestOptions, callback?: never) =>
    http.request(
      {
        ...options,
        protocol: 'http:',
        host: '127.0.0.1',
        hostname: '127.0.0.1',
        port: store.port,
        agent: undefined,
      },
      callback
    ),
});

const { deleteObjectsFromR2 } = await import('@/lib/r2/client');

const mode = process.argv[2];
const started = performance.now();
let outcome: Record<string, unknown>;
try {
  await deleteObjectsFromR2({
    keys: ['probe/stalled'],
    bucketType: 'private',
    ...(mode === 'signal' && { signal: AbortSignal.timeout(1000) }),
  });
  outcome = { settled: 'resolved' };
} catch (error) {
  outcome = {
    settled: 'rejected',
    name: error instanceof Error ? error.name : typeof error,
  };
}
console.log(
  JSON.stringify({ ...outcome, ms: Math.round(performance.now() - started) })
);
store.stop(true);
