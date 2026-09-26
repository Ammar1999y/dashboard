/**
 * Fields added to Better Auth's models, in the shape both the server's
 * `betterAuth({ user: { additionalFields } })` and the client's
 * `inferAdditionalFields({ user })` take, so the session type comes from one
 * declaration on both sides instead of the client importing the server.
 */
export const USER_ADDITIONAL_FIELDS = {
  // Better Auth reads the Drizzle result key (`roleId`), not the SQL column
  // name. Setting `fieldName: 'role_id'` drops the value from the session.
  roleId: {
    type: 'string',
    required: false,
    defaultValue: null,
    input: false,
  },
} as const;

export const SESSION_ADDITIONAL_FIELDS = {
  metadata: {
    type: 'json',
    required: false,
    defaultValue: '{}',
    input: false,
  },
} as const;
