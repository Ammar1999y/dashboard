/**
 * `R2_PUBLIC_URL`, parsed ONCE: `lib/env.server.ts` refuses a boot on
 * `invalid`, and `lib/r2/client.ts` joins object keys onto `origin`. Both read
 * it from here, so the value the gate accepted is the value every URL is built
 * from.
 *
 * Only an https origin is accepted: the value is concatenated with object keys
 * into URLs that are stored nowhere and rebuilt on every read, so a path, a
 * query or a fragment here would corrupt every one of them the same way.
 */
type PublicUrl =
  | { state: 'unset' }
  | { state: 'invalid' }
  | { state: 'valid'; origin: string; hostname: string };

function parsePublicUrl(raw: string | undefined): PublicUrl {
  const value = raw?.trim();
  if (!value) return { state: 'unset' };
  // `URL` reports a bare trailing `?` or `#` as an empty `search` and `hash`,
  // so only the raw text shows them.
  if (value.includes('?') || value.includes('#')) return { state: 'invalid' };

  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    return { state: 'invalid' };
  return { state: 'valid', origin: url.origin, hostname: url.hostname };
}

export const R2_PUBLIC_URL = parsePublicUrl(process.env.R2_PUBLIC_URL);
