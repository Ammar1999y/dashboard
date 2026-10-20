/**
 * What the media slice added to the binding layer, on the real application:
 * the exact body ceiling of each method on one path, the multipart form
 * read only after admission, the malformed-id 404 as a per-part override that
 * leaves the body's 422 alone, the strict media queries, and the upload admission limiter charged by the handler, after the
 * checks the gate cannot make.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';
import { db } from '@/db';
import { folders } from '@/db/schema';

import { listMedia } from '@app/shared/api/media';
import {
  FILE_NOT_FOUND_CODE,
  FILE_TYPE_NOT_ALLOWED_CODE,
  FOLDER_NOT_FOUND_CODE,
} from '@app/shared/error-codes';
import { sanitizeFilename } from '@app/shared/filename';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_BODY_TOO_LARGE,
  MSG_INVALID_INPUT,
} from '@app/shared/messages/common';
import { MSG_INVALID_FILTER } from '@app/shared/messages/data-table';
import { mediaMsg, uploadMsg } from '@app/shared/messages/media';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import {
  idRequired,
  mediaValidationMsg,
  MSG_UNRECOGNIZED_KEYS,
} from '@app/shared/messages/validation';

import { MAX_JSON_BODY_BYTES } from '@/lib/http/request';
import { generateUuidV7 } from '@/lib/id';
import { getRateLimitStore } from '@/lib/rate-limit/store';

import { resetTables } from '../helpers/database';
import { expectData, expectError } from '../helpers/expect-body';
import { authedRequest, signedInUser } from '../helpers/session';

const fx: {
  admin: SignedInSession | null;
  viewer: SignedInSession | null;
  folderId: string | null;
} = { admin: null, viewer: null, folderId: null };

const admin = () => {
  if (!fx.admin) throw new Error('fixture not seeded');
  return fx.admin;
};
const viewer = () => {
  if (!fx.viewer) throw new Error('fixture not seeded');
  return fx.viewer;
};
const folderId = () => {
  if (!fx.folderId) throw new Error('fixture not seeded');
  return fx.folderId;
};

beforeAll(async () => {
  await resetTables();
  fx.admin = await signedInUser();
  fx.viewer = await signedInUser({ permissions: { media: { view: true } } });
  const [row] = await db
    .insert(folders)
    .values({ name: 'Bindings', parentId: null, createdBy: null })
    .returning({ id: folders.id });
  fx.folderId = row?.id ?? null;
}, 30_000);

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Records which body readers a layer called on this request. */
function watchFormData(request: Request): string[] {
  const reads: string[] = [];
  const formData = request.formData.bind(request);
  Object.defineProperty(request, 'formData', {
    value: () => {
      reads.push('formData');
      return formData();
    },
  });
  return reads;
}

const FORM_FILE_NAME = 'probe.txt';

function fileForm(field: string, bytes: number, type: string): FormData {
  const form = new FormData();
  form.append(field, new File(['x'.repeat(bytes)], FORM_FILE_NAME, { type }));
  return form;
}

/** Between the JSON ceiling and the multipart one. */
const MIDDLE = MAX_JSON_BODY_BYTES * 2;

describe('one path, one ceiling per method', () => {
  test.each(['PUT', 'DELETE'] as const)(
    '%s /api/dash/media/files refuses a declared body over the JSON ceiling, unread',
    async (method) => {
      const body = JSON.stringify({ ids: ['x'.repeat(MIDDLE)] });
      const request = authedRequest(admin(), '/api/dash/media/files', {
        method,
        headers: { ...JSON_HEADERS, 'content-length': String(body.length) },
        body,
      });
      await expectError(
        await app.handle(request),
        HTTP_STATUS.CONTENT_TOO_LARGE,
        MSG_BODY_TOO_LARGE
      );
      expect(request.bodyUsed).toBe(false);
    }
  );

  test('PUT /api/dash/media/files stops reading a chunked body at the JSON ceiling', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > MIDDLE * 4) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await app.handle(
      authedRequest(admin(), '/api/dash/media/files', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: stream,
        // @ts-expect-error -- Bun's RequestInit does not declare `duplex`, which a streamed body needs
        duplex: 'half',
      })
    );
    await expectError(
      response,
      HTTP_STATUS.CONTENT_TOO_LARGE,
      MSG_BODY_TOO_LARGE
    );
    expect(pulled).toBeLessThan(MAX_JSON_BODY_BYTES + chunk.byteLength * 4);
  });

  test('POST /api/dash/media/files reads a form past the JSON ceiling', async () => {
    const form = fileForm('file', MIDDLE, 'text/plain');
    const request = authedRequest(
      admin(),
      `/api/dash/media/files?folder=${folderId()}`,
      { method: 'POST', body: form }
    );
    const { code } = await expectError(
      await app.handle(request),
      HTTP_STATUS.BAD_REQUEST,
      mediaMsg.typeNotAllowed(sanitizeFilename(FORM_FILE_NAME))
    );
    expect(code).toBe(FILE_TYPE_NOT_ALLOWED_CODE);
  });
});

describe('the library upload’s form, read only after admission', () => {
  const upload = (session: SignedInSession, query: string) => {
    const request = authedRequest(session, `/api/dash/media/files${query}`, {
      method: 'POST',
      body: new FormData(),
    });
    return { request, reads: watchFormData(request) };
  };

  test('an admitted request reads it once, through the lazy reader', async () => {
    const { request, reads } = upload(admin(), `?folder=${folderId()}`);
    await expectError(
      await app.handle(request),
      HTTP_STATUS.BAD_REQUEST,
      uploadMsg.noFiles
    );
    expect(reads).toEqual(['formData']);
  });

  test.each([
    [
      'no grant',
      viewer,
      (): string => `?folder=${folderId()}`,
      HTTP_STATUS.FORBIDDEN,
      MSG_INSUFFICIENT_PERMISSIONS,
    ],
    [
      'a malformed folder',
      admin,
      (): string => '?folder=x',
      HTTP_STATUS.UNPROCESSABLE,
      idRequired,
    ],
    [
      'an unknown folder',
      admin,
      (): string => `?folder=${generateUuidV7()}`,
      HTTP_STATUS.NOT_FOUND,
      mediaMsg.folderNotFound,
    ],
    [
      'an unknown query key',
      admin,
      (): string => `?folder=${folderId()}&extra=1`,
      HTTP_STATUS.UNPROCESSABLE,
      MSG_UNRECOGNIZED_KEYS(['extra'], 0),
    ],
    [
      'a repeated folder',
      admin,
      (): string => `?folder=${folderId()}&folder=${folderId()}`,
      HTTP_STATUS.UNPROCESSABLE,
      MSG_INVALID_INPUT,
    ],
  ] as const)(
    'a refusal for %s leaves it unread',
    async (_label, session, query, status, message) => {
      const { request, reads } = upload(session(), query());
      await expectError(await app.handle(request), status, message);
      expect(reads).toEqual([]);
      expect(request.bodyUsed).toBe(false);
    }
  );
});

describe('a malformed id is the not-found of its route, the body’s 422 stays', () => {
  const malformed = 'not-an-id';
  const VALID_FILE_EDIT = { displayName: 'renamed' };
  const VALID_FOLDER_EDIT = { name: 'renamed' };

  test.each([
    [
      'GET',
      `/api/dash/media/files/${malformed}`,
      undefined,
      FILE_NOT_FOUND_CODE,
    ],
    [
      'PUT',
      `/api/dash/media/files/${malformed}`,
      VALID_FILE_EDIT,
      FILE_NOT_FOUND_CODE,
    ],
    [
      'POST',
      `/api/dash/media/files/${malformed}/publish`,
      undefined,
      FILE_NOT_FOUND_CODE,
    ],
    [
      'POST',
      `/api/dash/media/files/${malformed}/unpublish`,
      undefined,
      FILE_NOT_FOUND_CODE,
    ],
    [
      'GET',
      `/api/dash/media/folders/${malformed}`,
      undefined,
      FOLDER_NOT_FOUND_CODE,
    ],
    [
      'PUT',
      `/api/dash/media/folders/${malformed}`,
      VALID_FOLDER_EDIT,
      FOLDER_NOT_FOUND_CODE,
    ],
    [
      'DELETE',
      `/api/dash/media/folders/${malformed}`,
      undefined,
      FOLDER_NOT_FOUND_CODE,
    ],
  ] as const)('%s %s', async (method, path, body, code) => {
    const response = await app.handle(
      authedRequest(admin(), path, {
        method,
        ...(body && { headers: JSON_HEADERS, body: JSON.stringify(body) }),
      })
    );
    const refusal = await expectError(
      response,
      HTTP_STATUS.NOT_FOUND,
      code === FILE_NOT_FOUND_CODE
        ? mediaMsg.fileNotFound
        : mediaMsg.folderNotFound
    );
    expect(refusal.code).toBe(code);
    expect(refusal.data).toBeUndefined();
  });

  test('a repeated query key does not hide it: params answer first', async () => {
    const response = await app.handle(
      authedRequest(
        admin(),
        `/api/dash/media/folders/${malformed}?recursive=true&recursive=true`,
        { method: 'DELETE' }
      )
    );
    const refusal = await expectError(
      response,
      HTTP_STATUS.NOT_FOUND,
      mediaMsg.folderNotFound
    );
    expect(refusal.code).toBe(FOLDER_NOT_FOUND_CODE);
  });

  test.each(['files', 'folders'])(
    'PUT %s/:id: with an invalid body too, the body’s refusal comes first',
    async (resource) => {
      const response = await app.handle(
        authedRequest(admin(), `/api/dash/media/${resource}/${malformed}`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: '{}',
        })
      );
      await expectError(
        response,
        HTTP_STATUS.UNPROCESSABLE,
        mediaValidationMsg.nothingToUpdate
      );
    }
  );
});

describe('the media queries', () => {
  const list = (query: string) =>
    app.handle(authedRequest(admin(), `/api/dash/media${query}`));

  test.each([
    ['?scope=bad', mediaMsg.invalidScope],
    ['?folder=nope', idRequired],
    ['?page=abc', MSG_INVALID_FILTER],
    ['?unknown=1', MSG_INVALID_FILTER],
    ['?page=1&page=2', MSG_INVALID_FILTER],
    ['?scope=all&scope=folder', MSG_INVALID_FILTER],
  ])('the listing refuses %s with its message', async (query, message) => {
    await expectError(await list(query), HTTP_STATUS.UNPROCESSABLE, message);
  });

  test('an empty folder is the root', async () => {
    const { data } = await expectData(await list('?folder='), listMedia);
    expect('breadcrumbs' in data && data.breadcrumbs).toEqual([]);
  });

  test.each([
    ['?recursive=please', mediaMsg.invalidRecursive],
    ['?recursive=true&recursive=false', MSG_INVALID_INPUT],
    ['?purge=1', MSG_UNRECOGNIZED_KEYS(['purge'], 0)],
  ])('a folder delete refuses %s', async (query, message) => {
    const response = await app.handle(
      authedRequest(admin(), `/api/dash/media/folders/${folderId()}${query}`, {
        method: 'DELETE',
      })
    );
    await expectError(response, HTTP_STATUS.UNPROCESSABLE, message);
  });

  test('the record upload answers every query refusal 400, a bad resource with its own message', async () => {
    const send = (query: string) =>
      app.handle(
        authedRequest(admin(), `/api/upload/file${query}`, {
          method: 'POST',
          body: new FormData(),
        })
      );
    await expectError(
      await send('?resource=nope'),
      HTTP_STATUS.BAD_REQUEST,
      uploadMsg.invalidResource
    );
    await expectError(
      await send('?resource=users&extra=1'),
      HTTP_STATUS.BAD_REQUEST,
      MSG_UNRECOGNIZED_KEYS(['extra'], 0)
    );
  });
});

describe('the upload admission limiter, charged by the handler', () => {
  const charged = (session: SignedInSession): number => {
    const statement = getRateLimitStore().db.prepare(
      'SELECT count FROM rate_limit WHERE key LIKE ?'
    );
    try {
      return statement
        .all<{ count: number }>(`%upload.admission:user:${session.user.userId}`)
        .reduce((total, row) => total + row.count, 0);
    } finally {
      statement.finalize();
    }
  };

  test('only once every check before the body has passed', async () => {
    const caller = await signedInUser({
      permissions: {
        media: { view: true, create: true },
        users: { view: true },
      },
    });
    const send = (path: string) =>
      app.handle(
        authedRequest(caller, path, { method: 'POST', body: new FormData() })
      );

    const missing = await expectError(
      await send(`/api/dash/media/files?folder=${generateUuidV7()}`),
      HTTP_STATUS.NOT_FOUND,
      mediaMsg.folderNotFound
    );
    expect(missing.code).toBe(FOLDER_NOT_FOUND_CODE);
    await expectError(
      await send('/api/upload/file?resource=users'),
      HTTP_STATUS.FORBIDDEN,
      MSG_INSUFFICIENT_PERMISSIONS
    );
    await expectError(
      await send('/api/upload/file?resource=media&purpose=nope'),
      HTTP_STATUS.BAD_REQUEST,
      mediaMsg.invalidPurpose
    );
    expect(charged(caller)).toBe(0);

    await expectError(
      await send(`/api/dash/media/files?folder=${folderId()}`),
      HTTP_STATUS.BAD_REQUEST,
      uploadMsg.noFiles
    );
    await expectError(
      await send('/api/upload/file?resource=media'),
      HTTP_STATUS.BAD_REQUEST,
      uploadMsg.noFiles
    );
    expect(charged(caller)).toBe(2);
  });
});
