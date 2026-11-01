/**
 * Spends `attempts` admissions on ONE key through the production `rateLimit`.
 * Opens the store first and prints `ready`, then waits for a line on stdin,
 * so sibling processes start contending together; prints
 * `{ admitted, refused, storeFailures, windowStart }` as its last line.
 *
 * argv: key limit windowSeconds attempts yieldWhenBusy(0|1)
 */
import { rateLimit } from '@/lib/rate-limit/fixed-window';
import { getRateLimitStore } from '@/lib/rate-limit/store';

const [key = '', limit, windowSeconds, attempts, yieldWhenBusy] =
  process.argv.slice(2);

getRateLimitStore();
console.log('ready');
for await (const _line of console) break;

const windowMs = Number(windowSeconds) * 1000;
const startedAt = Date.now();
let admitted = 0;
let refused = 0;
let storeFailures = 0;
for (let index = 0; index < Number(attempts); index++) {
  const result = await rateLimit({
    identifier: key,
    limit: Number(limit),
    window: Number(windowSeconds),
    yieldWhenBusy: yieldWhenBusy === '1',
    failClosed: true,
  });
  if (result.storeFailure) storeFailures++;
  else if (result.success) admitted++;
  else refused++;
}
const endedAt = Date.now();

console.log(
  JSON.stringify({
    admitted,
    refused,
    storeFailures,
    // Equal at both ends, or the run crossed a window and may admit twice.
    windowStart: startedAt - (startedAt % windowMs),
    windowEnd: endedAt - (endedAt % windowMs),
  })
);
