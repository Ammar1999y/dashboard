import { validateRedirectPath } from '@/utils/validate-redirect-path';

const KEY = 'redirect-path';

// Storage can be blocked (private mode, disabled site data); losing the
// return path must never stop the redirect it belongs to.

/** Remembers where a signed-out visitor was, for after they sign in. */
export function saveRedirectPath(path: string) {
  try {
    localStorage.setItem(KEY, path);
  } catch {
    // The visitor lands on the dashboard home instead.
  }
}

/** The remembered path, validated, and forgotten; the dashboard home without one. */
export function takeRedirectPath(): string {
  let path = '';
  try {
    path = localStorage.getItem(KEY) ?? '';
    localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
  return validateRedirectPath(path);
}
