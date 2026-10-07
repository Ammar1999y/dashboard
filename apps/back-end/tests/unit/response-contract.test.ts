/**
 * The shared success contract and the keyed wrappers held to it.
 *
 * `responseIssues` leans on `z.fromJSONSchema`, which zod marks
 * semi-experimental, so every case it is relied on for is pinned here: a zod
 * upgrade that changes one fails this file first.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerValue } from '@/lib/http/contract';
import type { ResponseData } from '@app/shared/response-contract';

import { MSG_FETCHED } from '@app/shared/messages/common';
import { responseIssues } from '@app/shared/response-contract';

import { apiRaw, apiSuccess, withApiErrors } from '@/lib/http/response';

import { compareCodeUnits } from '@/utils/text';

import {
  successEnvelope as envelope,
  mediaFileWire,
  mediaFolderWire,
  PAGE_META,
} from '../helpers/response-fixtures';

const file = mediaFileWire();
const folder = mediaFolderWire();

const folderData = (data: Record<string, unknown> = {}) => ({
  visibilities: ['private'],
  canPublish: false,
  breadcrumbs: [{ id: folder.id, name: folder.name }],
  folders: [folder],
  files: [file],
  ...data,
});

const folderView = (data: Record<string, unknown> = {}) =>
  envelope(folderData(data), { meta: PAGE_META });

const issue = (path: PropertyKey[], code: string) => ({ path, code });

describe('responseIssues accepts', () => {
  test('each member of a union, and both branches of a discriminated one', () => {
    expect(responseIssues('GET /api/dash/media', folderView())).toEqual([]);
    expect(
      responseIssues(
        'GET /api/dash/media',
        envelope(
          {
            visibilities: ['private', 'public'],
            canPublish: true,
            files: [file],
            folders: [{ ...folder, breadcrumbs: [] }],
            foldersTruncated: false,
          },
          { meta: PAGE_META }
        )
      )
    ).toEqual([]);
    expect(
      responseIssues(
        'GET /api/dash/media',
        envelope(
          {
            visibilities: [],
            canPublish: false,
            files: [],
            retentionDays: 7,
          },
          { meta: PAGE_META }
        )
      )
    ).toEqual([]);
    expect(
      responseIssues(
        'POST /api/auth/forgot-password/reset',
        envelope({ reset: true })
      )
    ).toEqual([]);
    expect(
      responseIssues(
        'POST /api/auth/forgot-password/reset',
        envelope({
          reset: false,
          twoFactorRequired: true,
          grant: 'grant',
          options: [
            {
              id: 'otp:email',
              method: 'otp',
              contactKind: 'email',
              channel: 'email',
            },
          ],
          defaultMethod: 'otp:email',
        })
      )
    ).toEqual([]);
    expect(
      responseIssues(
        'POST /api/dash/users/me/change-email',
        envelope({ otpSent: true })
      )
    ).toEqual([]);
  });

  test('the data: URLs mock mode serves', () => {
    expect(
      responseIssues(
        'POST /api/upload/file',
        envelope([{ ...file, url: 'data:image/webp;base64,UklGRg==' }])
      )
    ).toEqual([]);
  });
});

describe('responseIssues refuses', () => {
  test('a key the contract does not name, at any depth', () => {
    expect(
      responseIssues(
        'POST /api/upload/file',
        envelope([{ ...file, r2Key: 'private/logo.webp' }])
      )
    ).toContainEqual(issue(['data', 0], 'unrecognized_keys'));
    expect(
      responseIssues(
        'POST /api/auth/otp/verify',
        envelope({ verified: true }, { meta: PAGE_META })
      )
    ).toContainEqual(issue([], 'unrecognized_keys'));
  });

  test('a malformed id or date, which the client parses as plain strings', () => {
    const issues = responseIssues(
      'POST /api/dash/media/files',
      envelope({ ...file, id: crypto.randomUUID(), createdAt: 'yesterday' })
    );
    expect(issues).toContainEqual(issue(['data', 'id'], 'invalid_format'));
    expect(issues).toContainEqual(
      issue(['data', 'createdAt'], 'invalid_format')
    );
  });

  test('inside a union, at the branch that came closest', () => {
    expect(
      responseIssues(
        'GET /api/dash/media',
        folderView({ files: [{ ...file, r2Key: 'private/logo.webp' }] })
      )
    ).toEqual([issue(['data', 'files', 0], 'unrecognized_keys')]);
  });

  test('an enum or constant that exists only as metadata', () => {
    expect(
      responseIssues(
        'POST /api/dash/media/files',
        envelope({ ...file, mimeType: 'text/html' })
      )
    ).toContainEqual(issue(['data', 'mimeType'], 'invalid_value'));
    expect(
      responseIssues('POST /api/auth/otp/send', envelope({ nextAllowedIn: 31 }))
    ).toContainEqual(issue(['data', 'nextAllowedIn'], 'invalid_value'));
    expect(
      responseIssues(
        'POST /api/auth/forgot-password/reset',
        envelope({
          reset: false,
          twoFactorRequired: true,
          grant: 'grant',
          options: [
            {
              id: 'passkey',
              method: 'passkey',
              contactKind: null,
              channel: null,
            },
          ],
          defaultMethod: null,
        })
      )
    ).toEqual([issue(['data', 'options', 0, 'method'], 'invalid_value')]);
  });

  test('duplicate items where the contract says they are unique', () => {
    expect(
      responseIssues(
        'GET /api/dash/media',
        folderView({ visibilities: ['private', 'private'] })
      )
    ).toEqual([issue(['data', 'visibilities', 1], 'custom')]);
  });

  test('a body that matches two branches of a union, as the union', () => {
    expect(
      responseIssues(
        'POST /api/dash/users/me/change-email',
        envelope({ autoVerified: true, otpSent: true })
      )
    ).toContainEqual(issue(['data'], 'invalid_union'));
  });

  test('a paginated answer without meta, once though both checks see it', () => {
    expect(
      responseIssues('GET /api/dash/media', envelope(folderData()))
    ).toEqual([issue(['meta'], 'invalid_type')]);
  });

  test('a client refinement', () => {
    expect(
      responseIssues('POST /api/upload/file', envelope([{ ...file, url: '' }]))
    ).toContainEqual(issue(['data', 0, 'url'], 'too_small'));
  });

  test('with paths and codes only, never the values that failed', () => {
    const issues = responseIssues(
      'POST /api/dash/media/files',
      envelope({ ...file, id: 'secret-value', r2Key: 'secret-key' })
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const found of issues)
      expect(Object.keys(found).toSorted(compareCodeUnits)).toEqual([
        'code',
        'path',
      ]);
  });
});

describe('a keyed handler, at compile time', () => {
  // Each `@ts-expect-error` is the assertion: `bun run lint` fails once the
  // handler under it compiles. Built here, never called.
  const unmapped = (): undefined => {};

  const typedFile: ServerValue<ResponseData<'POST /api/dash/media/files'>> = {
    ...file,
    kind: 'image',
    bucketType: 'private',
    // A `Date` stands in for a plain string: the serialiser writes it as one.
    createdAt: new Date(),
  };

  test('refuses a wrong field and a wrong literal', () => {
    const misspelt = withApiErrors(
      'POST /api/auth/otp/verify',
      MSG_FETCHED,
      // @ts-expect-error -- the field is `verified`
      async () => {
        return apiSuccess({ message: MSG_FETCHED, data: { verifed: true } });
      },
      unmapped
    );
    const wrongLiteral = withApiErrors(
      'POST /api/auth/otp/verify',
      MSG_FETCHED,
      // @ts-expect-error -- `verified` is the literal `true`
      async () => {
        return apiSuccess({ message: MSG_FETCHED, data: { verified: false } });
      },
      unmapped
    );
    expect([misspelt.routeKey, wrongLiteral.routeKey]).toEqual([
      'POST /api/auth/otp/verify',
      'POST /api/auth/otp/verify',
    ]);
  });

  test('refuses a wrong discriminator', () => {
    const handler = withApiErrors(
      'POST /api/auth/forgot-password/reset',
      MSG_FETCHED,
      // @ts-expect-error -- `reset: false` is the branch that carries a grant
      async () => {
        return apiSuccess({ message: MSG_FETCHED, data: { reset: false } });
      },
      unmapped
    );
    expect(handler.routeKey).toBe('POST /api/auth/forgot-password/reset');
  });

  test('refuses a wrong enum value, and a Date in an enum field', () => {
    const wrongValue = withApiErrors(
      'POST /api/dash/media/files',
      MSG_FETCHED,
      // @ts-expect-error -- `kind` is `image` or `document`
      async () => {
        return apiSuccess({
          message: MSG_FETCHED,
          data: { ...typedFile, kind: 'video' },
        });
      },
      unmapped
    );
    const date = withApiErrors(
      'POST /api/dash/media/files',
      MSG_FETCHED,
      // @ts-expect-error -- a `Date` fits only where the wire is a plain string
      async () => {
        return apiSuccess({
          message: MSG_FETCHED,
          data: { ...typedFile, bucketType: new Date() },
        });
      },
      unmapped
    );
    expect([wrongValue.routeKey, date.routeKey]).toEqual([
      'POST /api/dash/media/files',
      'POST /api/dash/media/files',
    ]);
  });

  test('refuses a paginated answer without meta', () => {
    const handler = withApiErrors(
      'GET /api/dash/permissions',
      MSG_FETCHED,
      // @ts-expect-error -- a paginated route requires `meta`
      async () => {
        return apiSuccess({ message: MSG_FETCHED, data: [] });
      },
      unmapped
    );
    expect(handler.routeKey).toBe('GET /api/dash/permissions');
  });

  test('refuses a raw body from an envelope route', () => {
    const handler = withApiErrors(
      'POST /api/auth/otp/verify',
      MSG_FETCHED,
      // @ts-expect-error -- only the health check and the document answer raw
      async () => {
        return apiRaw({ body: { verified: true } });
      },
      unmapped
    );
    expect(handler.routeKey).toBe('POST /api/auth/otp/verify');
  });

  test('accepts the literal, the Date, and meta where they belong', () => {
    const handler = withApiErrors(
      'POST /api/dash/media/files',
      MSG_FETCHED,
      async () => {
        return apiSuccess({ message: MSG_FETCHED, data: typedFile });
      },
      unmapped
    );
    const paginated = withApiErrors(
      'GET /api/dash/permissions',
      MSG_FETCHED,
      async () => {
        return apiSuccess({ message: MSG_FETCHED, data: [], meta: PAGE_META });
      },
      unmapped
    );
    expect([handler.routeKey, paginated.routeKey]).toEqual([
      'POST /api/dash/media/files',
      'GET /api/dash/permissions',
    ]);
  });
});
