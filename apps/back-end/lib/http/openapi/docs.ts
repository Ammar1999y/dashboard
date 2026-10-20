/**
 * The field prose of `packages/shared/src/**\/*.docs.ts`, attached to zod's
 * `globalRegistry` when the generated document is first built. Imported
 * lazily, so neither the browser bundle nor a server that never builds the
 * document carries it. `tests/unit/openapi-document.test.ts` holds this list to
 * the files on disk.
 */
import type { DocsEntry } from '@app/shared/api/field-docs';

import * as z from 'zod';

import { ABANDONED_UPLOAD_MINUTES } from '@/lib/media/files';
import { FOLDER_SEARCH_LIMIT } from '@/lib/media/folders';
import {
  SIGNED_LINK_MIN_LIFETIME_S,
  SIGNING_WINDOW_S,
} from '@/lib/media/signing';

export const FIELD_DOCS_MODULES: Readonly<
  Record<string, () => Promise<{ docs: readonly DocsEntry[] }>>
> = {
  'responses/permissions.docs': () =>
    import('@app/shared/responses/permissions.docs'),
  'validation/permissions.docs': () =>
    import('@app/shared/validation/permissions.docs'),
  'responses/users.docs': () => import('@app/shared/responses/users.docs'),
  'validation/preferences.docs': () =>
    import('@app/shared/validation/preferences.docs'),
  'validation/sessions.docs': () =>
    import('@app/shared/validation/sessions.docs'),
  'responses/media.docs': () => import('@app/shared/responses/media.docs'),
  'validation/media.docs': () => import('@app/shared/validation/media.docs'),
  'responses/auth.docs': () => import('@app/shared/responses/auth.docs'),
  'validation/otp.docs': () => import('@app/shared/validation/otp.docs'),
  'data-table/query.docs': () => import('@app/shared/data-table/query.docs'),
  'api/wire.docs': () => import('@app/shared/api/wire.docs'),
  'responses/better-auth.docs': () =>
    import('@app/shared/responses/better-auth.docs'),
  'validation/health.docs': () => import('@app/shared/validation/health.docs'),
  'validation/rules.docs': () => import('@app/shared/validation/rules.docs'),
  'validation/auth.docs': () => import('@app/shared/validation/auth.docs'),
  'validation/two-factor.docs': () =>
    import('@app/shared/validation/two-factor.docs'),
};

/** The server-only values a sentence names as `{{name}}`. */
export const DOCS_VALUES: Readonly<Record<string, number>> = {
  abandonedUploadMinutes: ABANDONED_UPLOAD_MINUTES,
  folderSearchLimit: FOLDER_SEARCH_LIMIT,
  signingWindowMinutes: SIGNING_WINDOW_S / 60,
  signedLinkMinMinutes: SIGNED_LINK_MIN_LIFETIME_S / 60,
  signedLinkMaxMinutes: (SIGNING_WINDOW_S + SIGNED_LINK_MIN_LIFETIME_S) / 60,
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function fillPlaceholders(sentence: string): string {
  return sentence.replaceAll(PLACEHOLDER, (_match, name: string) => {
    const value = Object.hasOwn(DOCS_VALUES, name)
      ? DOCS_VALUES[name]
      : undefined;
    if (value === undefined)
      throw new Error(`Field docs name {{${name}}}, which nothing fills.`);
    return String(value);
  });
}

const memo: { loaded?: Promise<void> } = {};

export function loadFieldDocs(): Promise<void> {
  memo.loaded ??= (async () => {
    const modules = await Promise.all(
      Object.values(FIELD_DOCS_MODULES).map((load) => load())
    );
    for (const { docs } of modules)
      for (const entry of docs) attachFieldDocs(entry);
  })();
  return memo.loaded;
}

/**
 * A description belongs to the schema INSTANCE, so a reused instance carries
 * one sentence everywhere. Two different sentences for one instance are
 * refused: the field needs its own instance (a `.clone()` keeps its checks
 * and inherits its metadata).
 */
export function attachFieldDocs(entry: DocsEntry): void {
  if ('description' in entry) {
    describe(entry.schema, entry.description, 'The schema');
    return;
  }
  for (const [key, description] of Object.entries(entry.docs)) {
    if (description === undefined) continue;
    const field: unknown = entry.schema.shape[key];
    if (!(field instanceof z.ZodType))
      throw new Error(`Field docs name "${key}", which the schema lacks.`);
    describe(field, description, `Field "${key}"`);
  }
}

function describe(schema: z.ZodType, sentence: string, named: string): void {
  const description = fillPlaceholders(sentence);
  const meta = z.globalRegistry.get(schema);
  if (meta?.description !== undefined && meta.description !== description)
    throw new Error(
      `${named} already reads "${meta.description}"; give it its own instance for "${description}".`
    );
  z.globalRegistry.add(schema, { ...meta, description });
}
