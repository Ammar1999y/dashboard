/**
 * The email-verification login gate, which the integration tier cannot reach:
 * `REQUIRE_EMAIL_VERIFICATION` is a source constant read at module load, and the
 * shipped value is `false`. Prints ONE line of JSON: the sign-in answer, with
 * its content type, and every error-level log line it produced.
 */
import { mock, spyOn } from 'bun:test';

import { installEgressGuard } from '../helpers/egress';

const defaults = await import('@app/shared/config');
if (defaults.REQUIRE_EMAIL_VERIFICATION !== false)
  throw new Error('Shipped email verification default changed.');
await mock.module('@app/shared/config', () => ({
  ...defaults,
  REQUIRE_EMAIL_VERIFICATION: true,
}));

installEgressGuard();
const { seedUser, baseHeaders } = await import('../helpers/session');
const { app } = await import('@/app');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { closeDatabase } = await import('@/db');

const owner = await seedUser({ emailVerified: false });

const logged: string[] = [];
const errors = spyOn(console, 'error').mockImplementation((line: unknown) => {
  logged.push(String(line));
});
const response = await app.handle(
  new Request(`${PUBLIC_ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: baseHeaders({
      'content-type': 'application/json',
      origin: PUBLIC_ORIGIN,
    }),
    body: JSON.stringify({ email: owner.email, password: owner.password }),
  })
);
const body: unknown = await response.json();
errors.mockRestore();

await closeDatabase();
console.log(
  JSON.stringify({
    status: response.status,
    contentType: response.headers.get('content-type'),
    body,
    logged,
  })
);
