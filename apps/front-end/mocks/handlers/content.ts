import type { SettingsClient } from '@/types/settings';

import { http } from 'msw';
import { MSG_UPDATED } from '@app/shared/messages/common';

import { generateEntityId } from '@/utils/generate-id';
import {
  createSectionSchema,
  updateSectionBodySchema,
} from '@/utils/validation/sections';
import { settingsSchema } from '@/utils/validation/settings';

import { crud } from '../lib/crud';
import { now } from '../lib/db';
import { api, ok, readJsonBody } from '../lib/http';
import { contentMsg } from '../lib/messages';
import { sections, settings } from '../store';

/** A nav link the section picker wrote names the section by `#slug`. */
const linksToSection = (slug: string) =>
  !!settings.get()?.navLinks?.some(({ link }) => link === `#${slug}`);

// No back-end serves these yet: the mocks are their only implementation, and
// they parse bodies with the forms' schemas and hold the integrity rules as
// that back-end will. Swapping in the real routes needs no front-end change if
// they keep this contract.
export const contentHandlers = [
  ...crud(
    '/api/dash/sections',
    sections,
    { create: createSectionSchema, update: updateSectionBodySchema },
    {
      unique: [{ field: 'slug', message: contentMsg.slugExists }],
      referencedBy: [
        {
          inUse: ({ slug }) => linksToSection(slug),
          message: contentMsg.sectionInNavLinks,
        },
      ],
    }
  ),

  http.get(api('/api/dash/settings'), () => ok(settings.get())),

  // An upsert, answered as the server answers its own: 200 whether or not a
  // row existed.
  http.post(api('/api/dash/settings'), async ({ request }) => {
    const input = await readJsonBody(request, settingsSchema);
    const current = settings.get();
    const timestamp = now();
    const next: SettingsClient = {
      ...input,
      id: current?.id ?? generateEntityId(),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    settings.set(next);
    return ok(
      { id: next.id, createdAt: next.createdAt, updatedAt: next.updatedAt },
      MSG_UPDATED
    );
  }),
];
