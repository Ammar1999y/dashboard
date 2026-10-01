/**
 * The one reader for every first-factor path, so an account cannot get two
 * session lifetimes. ⚠️ Absent means `true`, Better Auth's own `/sign-in/email`
 * default; only an explicit `false` shortens a session.
 */
import { HONOUR_REMEMBER_ME } from '@app/shared/config';

export function submittedRememberMe(body: unknown): boolean {
  if (!HONOUR_REMEMBER_ME || !body || typeof body !== 'object') return true;
  return (body as { rememberMe?: unknown }).rememberMe !== false;
}
