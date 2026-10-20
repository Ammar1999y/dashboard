import { ENDPOINTS } from '@app/shared/api/all';

/** The shared entry named `METHOD /path`, as a binding's `key` names it. */
export function entryAt(key: string) {
  const entry = ENDPOINTS.find(
    ({ method, path }) => `${method} ${path}` === key
  );
  if (!entry) throw new Error(`No entry is ${key}.`);
  return entry;
}
