import * as z from 'zod';

import {
  idRequired,
  MSG_SESSION_IDS_REQUIRED,
  MSG_SESSION_IDS_TOO_MANY,
  MSG_SESSIONS_DELETE_SHAPE,
} from '../messages/validation';
import { UUID_V7_FRAGMENT } from '../utils';
import { IDS_ARRAY_MAX } from './constants';
import { idSchema } from './rules';

export const SESSIONS_PAGE_SIZE = 50;
export const SESSIONS_MAX_PAGE_SIZE = 100;
export const SESSION_CURSOR_MAX_LENGTH = 128;
export const SESSION_CURSOR_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|${UUID_V7_FRAGMENT}$`;

/**
 * `DELETE /api/dash/users/:id/sessions`: named sessions, or every other one.
 */
export const deleteSessionsSchema = z.union(
  [
    z
      .object({
        sessionIds: z
          .array(idSchema, { message: idRequired })
          .min(1, MSG_SESSION_IDS_REQUIRED)
          .max(IDS_ARRAY_MAX, MSG_SESSION_IDS_TOO_MANY),
      })
      .strict(),
    // Emergency path: end every other session in one transaction, without
    // having to enumerate ids that pagination may not even have surfaced yet.
    z.object({ revokeAll: z.literal(true) }).strict(),
  ],
  // Zod reports the branch's own issue when exactly one branch matched the shape
  // and failed a constraint inside it (`{sessionIds: []}`, 51 ids), and this
  // message when none got that far (a bad id, `revokeAll: false`, `{}`). All
  // three messages are live client copy.
  { error: MSG_SESSIONS_DELETE_SHAPE }
);
