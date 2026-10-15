/**
 * The document's operation groups. Every binding names one, so a typo is a
 * compile error rather than a tag the document lists nowhere.
 */
export const OPERATION_TAGS = [
  {
    name: 'Authentication',
    description: 'Sign-in, sign-out, password recovery, and OTP flows.',
  },
  {
    name: 'Account',
    description: 'Authenticated self-service account changes.',
  },
  {
    name: 'Permissions',
    description: 'Dashboard roles and permission matrices.',
  },
  { name: 'Users', description: 'Dashboard user administration.' },
  {
    name: 'Sessions',
    description: 'User session inspection and revocation.',
  },
  {
    name: 'Media',
    description:
      'The media library: folders, files, and their public/private visibility.',
  },
  {
    name: 'Uploads',
    description:
      'Uploads made for a dashboard record, pending until that record claims them.',
  },
  { name: 'Operations', description: 'Deployment readiness probes.' },
  {
    name: 'Development',
    description: 'Endpoints registered only in development mode.',
  },
  { name: 'Contract', description: 'The generated OpenAPI document.' },
] as const;

export type OperationTag = (typeof OPERATION_TAGS)[number]['name'];
