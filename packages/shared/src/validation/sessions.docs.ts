import { fieldDocs } from '../api/field-docs';
import {
  SESSIONS_MAX_PAGE_SIZE,
  SESSIONS_PAGE_SIZE,
  sessionsQuerySchema,
} from './sessions';

export const docs = [
  fieldDocs(sessionsQuerySchema, {
    limit: `Page size, 1 to ${SESSIONS_MAX_PAGE_SIZE} written without a sign or leading zeros; ${SESSIONS_PAGE_SIZE} when omitted.`,
    cursor:
      'Cursor returned by the previous page: ISO-8601 UTC milliseconds, a pipe, then a UUIDv7. Omitted means the first page.',
  }),
];
