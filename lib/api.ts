import { API_URL } from '@/lib/env';

/** Resolve an API path against the standalone backend origin. */
function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;

  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return new URL(normalizedPath, `${API_URL}/`).toString();
}

/** Fetch from the standalone backend and include its session cookie. */
export function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
  });
}
