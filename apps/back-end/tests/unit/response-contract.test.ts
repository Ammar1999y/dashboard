/**
 * The shared success contract. What a binding's handler may return is
 * `contract-types.test.ts`'s.
 *
 * `responseIssues` leans on `z.fromJSONSchema`, which zod marks
 * semi-experimental, so every case it is relied on for is pinned here: a zod
 * upgrade that changes one fails this file first.
 */
import { describe, expect, test } from 'bun:test';

import { responseIssues } from '@app/shared/response-contract';

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
