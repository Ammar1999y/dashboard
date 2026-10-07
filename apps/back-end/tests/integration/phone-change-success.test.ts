/**
 * The phone change's 2xx answers, which only a deployment with a phone OTP
 * channel can give. This tier enables email alone (as CI does), so a child with
 * `email,sms` gives them; without it the response-contract coverage gate would
 * never see either answer.
 */
import { expect, test } from 'bun:test';

test('a phone change answers its code-sent and its verified success', async () => {
  const child = Bun.spawn(
    ['bun', '--no-env-file', 'tests/fixtures/_phone-change-child.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email,sms' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status, error).toBe(0);
  expect(output).toContain('change-phone answered both of its successes.');
}, 60_000);
