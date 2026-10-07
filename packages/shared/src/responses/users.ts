import * as z from 'zod';

import { CUSTOM_ROLE_VALUE } from '../permissions/constants';
import { UUID_V7_REGEX } from '../utils';
import { preferencesSchema } from '../validation/preferences';
import { SESSION_CURSOR_PATTERN } from '../validation/sessions';
import { dateTime, email, idSet, uuid } from './common';
import { permissionMatrixSchema, roleSummarySchema } from './permissions';

export const contactChangeStartedSchema = z.xor([
  z.object({ autoVerified: z.literal(true) }),
  z.object({ otpSent: z.literal(true) }),
]);

// A role's id, or `custom` for a matrix of the user's own. The UUIDv7 form is
// a check rather than metadata because the client enforces it today.
const roleIdMembers = () =>
  [
    z.string().regex(UUID_V7_REGEX).meta({ format: 'uuid' }),
    z.literal(CUSTOM_ROLE_VALUE),
  ] as const;

const userRowSchema = z.object({
  id: uuid(),
  name: z.string(),
  email: email(),
  isActive: z.boolean(),
  roleId: z.union(roleIdMembers()),
  role: roleSummarySchema,
  createdAt: dateTime(),
  updatedAt: dateTime(),
});

export const userRowsSchema = z.array(userRowSchema);

const sessionSchema = z.object({
  id: uuid(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: dateTime(),
  isCurrent: z.boolean(),
});

const sessionCursor = () =>
  z.string().meta({ pattern: SESSION_CURSOR_PATTERN }).nullable();

/** Exported beside the refined schema: zod throws on `.pick()`, `.omit()` and `.partial()` of that one. */
export const userDetailBaseSchema = z.object({
  id: uuid(),
  name: z.string(),
  email: email(),
  emailVerified: z.boolean(),
  phoneNumber: z.string().nullable(),
  phoneNumberVerified: z.boolean(),
  isActive: z.boolean(),
  roleId: z.union([...roleIdMembers(), z.null()]),
  role: roleSummarySchema.nullable(),
  createdAt: dateTime(),
  updatedAt: dateTime(),
  // The role's rows, as `GET /api/dash/permissions/:id` sends them, not the
  // page-keyed matrix of the session metadata.
  permissions: permissionMatrixSchema,
  sessions: z.array(sessionSchema).optional(),
  sessionsHasMore: z.boolean().optional(),
  sessionsNextCursor: sessionCursor().optional(),
});

/** The first page of sessions comes whole or not at all: only a viewer who may read them gets it. */
export const userDetailSchema = userDetailBaseSchema.refine(
  ({ sessions, sessionsHasMore, sessionsNextCursor }) => {
    const present = [sessions, sessionsHasMore, sessionsNextCursor].filter(
      (value) => value !== undefined
    ).length;
    return present === 0 || present === 3;
  }
);

export const sessionsPageSchema = z.object({
  sessions: z.array(sessionSchema),
  nextCursor: sessionCursor(),
});

export const revokedSessionsSchema = z.object({ revoked: idSet() });

// The request's own fields, which neither preprocess nor carry metadata, in a
// plain object: a field the server adds later is dropped rather than refused.
export const storedPreferencesSchema = z.object({
  preferences: z.object(preferencesSchema.shape),
  updatedAt: dateTime().nullable(),
});
