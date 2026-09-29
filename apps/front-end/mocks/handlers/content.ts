import type { SettingsClient } from '@/types/settings';

import { generateUUIDv7 } from '@/utils';
import { delay, http } from 'msw';

import { crud } from '../lib/crud';
import { now } from '../lib/db';
import { api, fail, MSG, ok, readBody } from '../lib/http';
import { categories, projects, sections, settings } from '../store';

async function toDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return `data:${file.type};base64,${btoa(binary)}`;
}

export const contentHandlers = [
  // Ahead of projects: `/api/dash/projects/:id` would also match `categories`.
  ...crud('/api/dash/projects/categories', categories),
  ...crud('/api/dash/projects', projects),
  ...crud('/api/dash/sections', sections),

  http.get(api('/api/dash/settings'), () => ok(settings.get())),

  http.post(api('/api/dash/settings'), async ({ request }) => {
    const { id: _, ...body } = await readBody<SettingsClient>(request);
    const current = settings.get();
    const timestamp = now();
    const next = {
      ...current,
      ...body,
      id: current?.id ?? generateUUIDv7(),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    } as SettingsClient;
    settings.set(next);
    return ok(
      { id: next.id, createdAt: next.createdAt, updatedAt: next.updatedAt },
      MSG.updated
    );
  }),

  http.post(api('/api/upload'), async ({ request }) => {
    await delay();
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return fail(422, MSG.invalidInput);
    // A data URL, not a blob URL: a saved record still shows it after a reload.
    return ok({
      url: await toDataUrl(file),
      name: file.name,
      size: file.size,
      type: file.type,
    });
  }),
];
