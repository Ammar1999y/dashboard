/**
 * Files and folders as one selection: the move, the delete and its preview.
 *
 * - **The delete is one transaction.** Every file is marked and detached, and
 *   every folder deleted, or nothing changes; the objects go after the commit.
 * - **The preview is the delete's own reading.** Each blocker the delete refuses
 *   with is a list the preview answers, for the same body.
 * - **The lock order holds under real contention.** The schedules that
 *   deadlocked or deleted the wrong file before run against two real
 *   transactions, with holds kept short (`tests/integration` stalls on long
 *   real waits).
 *
 * Fixtures are seeded through the database: the routes' per-user budgets would
 * otherwise be spent on setup.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import { isLockNotAvailable } from '@/db/errors';
import { auditLogs, files, folders } from '@/db/schema';

import {
  FILE_BUSY_CODE,
  FILE_IN_USE_CODE,
  FILE_NOT_FOUND_CODE,
  FOLDER_BUSY_CODE,
  FOLDER_CYCLE_CODE,
  FOLDER_NAME_EXISTS_CODE,
  FOLDER_NOT_EMPTY_CODE,
  FOLDER_NOT_FOUND_CODE,
  FOLDER_TOO_DEEP_CODE,
  FOLDER_TOO_MANY_CHILDREN_CODE,
  SELECTION_TOO_LARGE_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { mediaValidationMsg } from '@app/shared/messages/validation';
import { mediaRefusalDataSchema } from '@app/shared/responses/media';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
  FOLDER_RECURSIVE_DELETE_MAX,
} from '@app/shared/validation/constants';

import { generateUuidV7 } from '@/lib/id';
import * as actorModule from '@/lib/media/actor';
import { lockTree } from '@/lib/media/folders';
import { sweepFiles } from '@/lib/media/lifecycle';
import * as r2Module from '@/lib/r2/client';

import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import {
  clearObjectStoreFailures,
  failObjectStore,
} from '../helpers/object-store';
import { resetRateLimits } from '../helpers/rate-limit';
import { authedRequest, signedInUser } from '../helpers/session';
import { recordStatements } from '../helpers/statements';
import {
  createReferrerTable,
  dropReferrerTable,
  PUBLIC_SOURCE,
  refer,
  unrefer,
  withSource,
} from '../helpers/usage-registry';

interface Answer {
  status: number;
  body: {
    message?: string;
    detail?: string;
    code?: string;
    data?: unknown;
  };
}

async function call(
  session: SignedInSession,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  json?: unknown
): Promise<Answer> {
  const response = await app.handle(
    authedRequest(session, path, {
      method,
      ...(json !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(json),
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

const sorted = (ids: readonly string[]) => ids.toSorted(compareCodeUnits);

async function seedFolder(
  name: string,
  parentId: string | null = null,
  createdBy: string | null = admin().user.userId
): Promise<string> {
  const [row] = await db
    .insert(folders)
    .values({ name, parentId, createdBy })
    .returning({ id: folders.id });
  if (!row) throw new Error('seedFolder returned no row');
  return row.id;
}

interface SeedFile {
  folderId: string | null;
  status?: 'pending' | 'active' | 'deleting';
  uploadedBy?: string | null;
  /** Minutes ago; past `ABANDONED_AFTER` a pending row is abandoned. */
  ageMinutes?: number;
  busy?: boolean;
}

async function seedFiles(count: number, options: SeedFile): Promise<string[]> {
  if (count === 0) return [];
  const createdAt =
    options.ageMinutes === undefined
      ? undefined
      : new Date(Date.now() - options.ageMinutes * 60_000);
  const rows = await db
    .insert(files)
    .values(
      Array.from({ length: count }, () => {
        const id = generateUuidV7();
        return {
          id,
          r2Key: `m/2026/10/${id}.webp`,
          bucketType: 'private' as const,
          status: options.status ?? 'active',
          kind: 'image' as const,
          folderId: options.folderId,
          displayName: `${id}.webp`,
          mimeType: 'image/webp',
          sizeBytes: 10,
          uploadedBy:
            options.uploadedBy === undefined
              ? admin().user.userId
              : options.uploadedBy,
          ...(createdAt && { createdAt }),
          ...(options.busy && {
            transition: 'to_public' as const,
            transitionId: generateUuidV7(),
          }),
        };
      })
    )
    .returning({ id: files.id });
  return rows.map((row) => row.id);
}

async function seedFile(options: SeedFile): Promise<string> {
  const [id] = await seedFiles(1, options);
  if (!id) throw new Error('seedFile returned no row');
  return id;
}

async function fileRow(id: string) {
  const [row] = await db
    .select({ status: files.status, folderId: files.folderId })
    .from(files)
    .where(eq(files.id, id));
  return row ?? null;
}

async function folderRow(id: string) {
  const [row] = await db
    .select({ parentId: folders.parentId, name: folders.name })
    .from(folders)
    .where(eq(folders.id, id));
  return row ?? null;
}

async function remainingFolders(ids: readonly string[]): Promise<number> {
  const rows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(inArray(folders.id, [...ids]));
  return rows.length;
}

function expectRefusal(
  answer: Answer,
  status: number,
  code: string,
  data?: unknown
): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status);
  expect(answer.body.detail).toEqual(expect.any(String));
  expect(answer.body.message).toBeUndefined();
  expect(answer.body.code).toBe(code);
  expect(answer.body.data).toEqual(data);
  if (answer.body.data !== undefined)
    expect(mediaRefusalDataSchema.safeParse(answer.body.data).success).toBe(
      true
    );
}

interface Preview {
  folders: number;
  files: number;
  limit: number;
  exceedsLimit: boolean;
  nonEmptyFolderIds: string[] | null;
  busyFileIds: string[] | null;
  inUseFileIds: string[] | null;
  unfinishedFolderIds: string[] | null;
}

async function preview(
  session: SignedInSession,
  body: Record<string, unknown>
): Promise<Preview> {
  const answer = await call(
    session,
    'POST',
    '/api/dash/media/delete-preview',
    body
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
  return answer.body.data as Preview;
}

const clear = {
  exceedsLimit: false,
  nonEmptyFolderIds: [],
  busyFileIds: [],
  inUseFileIds: [],
  unfinishedFolderIds: [],
};

/** Resolves once another backend waits on a lock while running `fragment`. */
async function waitForLockWait(fragment: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const rows = await db.execute(sql`select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock' and query like ${`%${fragment}%`}`);
    if (rows.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`No backend reached a lock wait on ${fragment}.`);
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

const sessions: {
  admin?: SignedInSession;
  own?: SignedInSession;
  other?: SignedInSession;
} = {};
function admin() {
  if (!sessions.admin) throw new Error('admin not seeded');
  return sessions.admin;
}
function own() {
  if (!sessions.own) throw new Error('own not seeded');
  return sessions.own;
}
function other() {
  if (!sessions.other) throw new Error('other not seeded');
  return sessions.other;
}

beforeAll(async () => {
  await resetTables();
  await createReferrerTable();
  sessions.admin = await signedInUser();
  sessions.own = await signedInUser({
    permissions: {
      media: {
        view: true,
        create: true,
        editOwn: true,
        deleteOwn: true,
      },
    },
  });
  sessions.other = await signedInUser();
}, 30_000);

afterAll(async () => {
  await dropReferrerTable();
});

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  clearObjectStoreFailures();
});

describe('the delete and its preview', () => {
  test('a recursive delete removes the whole tree in one transaction and names every folder', async () => {
    const top = await seedFolder('Delete top');
    const child = await seedFolder('Delete child', top);
    const grandchild = await seedFolder('Delete grandchild', child);
    const [inTop, inGrandchild] = [
      await seedFile({ folderId: top }),
      await seedFile({ folderId: grandchild }),
    ];
    const loose = await seedFile({
      folderId: await seedFolder('Delete loose'),
    });
    const body = {
      folderIds: [top],
      fileIds: [loose],
      recursive: true,
    };

    expect(await preview(admin(), body)).toEqual({
      folders: 3,
      files: 3,
      limit: FOLDER_RECURSIVE_DELETE_MAX,
      ...clear,
    });

    const answer = await call(admin(), 'DELETE', '/api/dash/media', body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toEqual({
      folders: 3,
      folderIds: sorted([top, child, grandchild]),
      deleted: expect.arrayContaining([inTop, inGrandchild, loose]),
      pending: [],
    });
    expect(await remainingFolders([top, child, grandchild])).toBe(0);
    for (const id of [inTop, inGrandchild, loose])
      expect(await fileRow(id)).toBeNull();

    const audited = await db
      .select({ recordId: auditLogs.recordId })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.tableName, 'folders'), eq(auditLogs.action, 'DELETE'))
      );
    expect(audited.map((row) => row.recordId)).toEqual(
      expect.arrayContaining([top, child, grandchild])
    );
  });

  /**
   * The audit rows are written under the tree lock and the row locks, where a
   * statement per item was about 45% of a capped delete's hold (measured).
   */
  test('a delete audits every file and folder in one statement', async () => {
    const top = await seedFolder('Audit top');
    const child = await seedFolder('Audit child', top);
    const inside = await seedFiles(3, { folderId: child });

    const recorder = recordStatements();
    let answer: Answer;
    try {
      answer = await call(admin(), 'DELETE', '/api/dash/media', {
        folderIds: [top],
        recursive: true,
      });
    } finally {
      recorder.stop();
    }
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(recorder.matching(/^insert into "audit_logs"/i)).toHaveLength(1);

    const audited = await db
      .select({
        tableName: auditLogs.tableName,
        recordId: auditLogs.recordId,
        oldData: auditLogs.oldData,
      })
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.recordId, [top, child, ...inside]),
          eq(auditLogs.action, 'DELETE')
        )
      );
    expect(audited).toHaveLength(5);
    expect(audited.find((row) => row.recordId === child)?.oldData).toEqual({
      name: 'Audit child',
      parentId: top,
    });
    expect(
      audited
        .filter((row) => row.tableName === 'files')
        .map((row) => row.recordId)
    ).toEqual(expect.arrayContaining(inside));
  });

  test('an item inside another selected folder is dropped, so it is neither counted twice nor refused', async () => {
    const top = await seedFolder('Nested top');
    const child = await seedFolder('Nested child', top);
    const inChild = await seedFile({ folderId: child });
    const body = {
      folderIds: [top, child],
      fileIds: [inChild],
      recursive: true,
    };

    expect(await preview(admin(), body)).toMatchObject({
      folders: 2,
      files: 1,
    });
    const answer = await call(admin(), 'DELETE', '/api/dash/media', body);
    expect(answer.status).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toMatchObject({
      folders: 2,
      deleted: [inChild],
    });
  });

  test('without recursive a folder holding anything active is refused by id; abandoned uploads go with it', async () => {
    const empty = await seedFolder('Holds abandoned');
    const abandoned = await seedFile({
      folderId: empty,
      status: 'pending',
      ageMinutes: 11,
    });
    const full = await seedFolder('Holds a file');
    await seedFile({ folderId: full });
    const parent = await seedFolder('Holds a folder');
    await seedFolder('Inside', parent);

    const refusedBody = { folderIds: [empty, full, parent] };
    expect(await preview(admin(), refusedBody)).toMatchObject({
      nonEmptyFolderIds: sorted([full, parent]),
    });
    expectRefusal(
      await call(admin(), 'DELETE', '/api/dash/media', refusedBody),
      HTTP_STATUS.CONFLICT,
      FOLDER_NOT_EMPTY_CODE,
      { folderIds: sorted([full, parent]) }
    );
    expect(await fileRow(abandoned)).toMatchObject({ status: 'pending' });

    expect(await preview(admin(), { folderIds: [empty] })).toEqual({
      folders: 1,
      files: 1,
      limit: FOLDER_RECURSIVE_DELETE_MAX,
      ...clear,
    });
    const answer = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${empty}`
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toEqual({
      folders: 1,
      folderIds: [empty],
      deleted: [abandoned],
      pending: [],
    });
    expect(await fileRow(abandoned)).toBeNull();
  });

  test('a fresh upload answers FOLDER_BUSY with its folder, in both modes, and an abandoned one does not', async () => {
    const top = await seedFolder('Busy top');
    const child = await seedFolder('Busy child', top);
    await seedFile({ folderId: child, status: 'pending', ageMinutes: 1 });
    await seedFile({ folderId: top, status: 'pending', ageMinutes: 30 });

    expect(
      await preview(admin(), { folderIds: [top], recursive: true })
    ).toMatchObject({ unfinishedFolderIds: [child] });
    expectRefusal(
      await call(admin(), 'DELETE', '/api/dash/media', {
        folderIds: [top],
        recursive: true,
      }),
      HTTP_STATUS.CONFLICT,
      FOLDER_BUSY_CODE,
      { folderIds: [child] }
    );

    const lone = await seedFolder('Busy alone');
    await seedFile({ folderId: lone, status: 'pending', ageMinutes: 1 });
    expect(await preview(admin(), { folderIds: [lone] })).toMatchObject({
      nonEmptyFolderIds: [],
      unfinishedFolderIds: [lone],
    });
    expectRefusal(
      await call(admin(), 'DELETE', `/api/dash/media/folders/${lone}`),
      HTTP_STATUS.CONFLICT,
      FOLDER_BUSY_CODE,
      { folderIds: [lone] }
    );
  });

  test('a file mid-transition refuses with FILE_BUSY and its id; the preview lists it', async () => {
    const folder = await seedFolder('Transition');
    const busy = await seedFile({ folderId: folder, busy: true });
    const calm = await seedFile({ folderId: folder });
    const body = { folderIds: [folder], recursive: true };

    expect(await preview(admin(), body)).toMatchObject({ busyFileIds: [busy] });
    expectRefusal(
      await call(admin(), 'DELETE', '/api/dash/media', body),
      HTTP_STATUS.CONFLICT,
      FILE_BUSY_CODE,
      { fileIds: [busy] }
    );
    expect(await fileRow(calm)).toMatchObject({ status: 'active' });
  });

  test('a referenced file refuses the whole selection with FILE_IN_USE and its id; nothing changes', async () => {
    await withSource(PUBLIC_SOURCE, async () => {
      const folder = await seedFolder('In use');
      const held = await seedFile({ folderId: folder });
      const free = await seedFile({ folderId: folder });
      await refer(held);
      try {
        const body = { folderIds: [folder], recursive: true };
        expect(await preview(admin(), body)).toMatchObject({
          inUseFileIds: [held],
        });
        const answer = await call(admin(), 'DELETE', '/api/dash/media', body);
        expectRefusal(answer, HTTP_STATUS.CONFLICT, FILE_IN_USE_CODE, {
          fileIds: [held],
        });
        expect(answer.body.detail).toBe(
          mediaMsg.fileInUseBy([PUBLIC_SOURCE.label], 0)
        );
        expect(await fileRow(free)).toMatchObject({
          status: 'active',
          folderId: folder,
        });
        expect(await folderRow(folder)).not.toBeNull();
      } finally {
        await unrefer(held);
      }
    });
  });

  test(`${FOLDER_RECURSIVE_DELETE_MAX} items besides the selected folders go; one more is refused whole`, async () => {
    const top = await seedFolder('Cap top');
    const child = await seedFolder('Cap child', top);
    // Folder, contained files, a contained file also selected, and a loose
    // selected file: everything counts once, the selected folder never.
    const inside = await seedFiles(FOLDER_RECURSIVE_DELETE_MAX - 3, {
      folderId: child,
    });
    const [alsoSelected] = await seedFiles(1, { folderId: top });
    const loose = await seedFile({ folderId: await seedFolder('Cap loose') });
    if (!alsoSelected) throw new Error('no file');
    const atCap = {
      folderIds: [top],
      fileIds: [alsoSelected, loose],
      recursive: true,
    };
    expect(await preview(admin(), atCap)).toMatchObject({
      folders: 2,
      files: inside.length + 2,
      exceedsLimit: false,
    });

    const extra = await seedFile({ folderId: child });
    const over = await preview(admin(), atCap);
    expect(over).toEqual({
      folders: 2,
      files: inside.length + 3,
      limit: FOLDER_RECURSIVE_DELETE_MAX,
      exceedsLimit: true,
      nonEmptyFolderIds: null,
      busyFileIds: null,
      inUseFileIds: null,
      unfinishedFolderIds: null,
    });
    const refused = await call(admin(), 'DELETE', '/api/dash/media', atCap);
    expectRefusal(refused, HTTP_STATUS.UNPROCESSABLE, SELECTION_TOO_LARGE_CODE);
    expect(refused.body.detail).toBe(mediaMsg.selectionTooLarge);
    const single = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${top}?recursive=true`
    );
    // Without the loose file the tree alone is exactly at the cap.
    expect(single.status, JSON.stringify(single.body)).toBe(HTTP_STATUS.OK);
    expect(await fileRow(extra)).toBeNull();
    expect(await fileRow(loose)).toMatchObject({ status: 'active' });
  });

  test('the folder route keeps its own message for a tree over the cap', async () => {
    const top = await seedFolder('Cap single');
    await seedFiles(FOLDER_RECURSIVE_DELETE_MAX + 1, { folderId: top });
    const answer = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${top}?recursive=true`
    );
    expectRefusal(answer, HTTP_STATUS.UNPROCESSABLE, SELECTION_TOO_LARGE_CODE);
    expect(answer.body.detail).toBe(mediaMsg.folderTooLarge);
  });

  test('an own scope reaches the files too: anything someone else made answers 404, in the preview as in the delete', async () => {
    const mine = await seedFolder('Own tree', null, own().user.userId);
    await seedFile({ folderId: mine, uploadedBy: other().user.userId });
    const body = { folderIds: [mine], recursive: true };

    const previewed = await call(
      own(),
      'POST',
      '/api/dash/media/delete-preview',
      body
    );
    expectRefusal(previewed, HTTP_STATUS.NOT_FOUND, FILE_NOT_FOUND_CODE);
    expectRefusal(
      await call(own(), 'DELETE', '/api/dash/media', body),
      HTTP_STATUS.NOT_FOUND,
      FILE_NOT_FOUND_CODE
    );
    const theirs = await seedFolder('Not mine', null, other().user.userId);
    expectRefusal(
      await call(own(), 'DELETE', '/api/dash/media', { folderIds: [theirs] }),
      HTTP_STATUS.NOT_FOUND,
      FOLDER_NOT_FOUND_CODE
    );
    expect(await folderRow(mine)).not.toBeNull();
  });

  test("someone else's unfinished upload in an own folder: a fresh one is FOLDER_BUSY, an abandoned one goes with the folder", async () => {
    for (const recursive of [false, true]) {
      const mine = await seedFolder(
        `Own uploads ${String(recursive)}`,
        null,
        own().user.userId
      );
      const upload = await seedFile({
        folderId: mine,
        status: 'pending',
        uploadedBy: other().user.userId,
      });
      const body = { folderIds: [mine], recursive };

      expect(await preview(own(), body)).toMatchObject({
        unfinishedFolderIds: [mine],
      });
      expectRefusal(
        await call(own(), 'DELETE', '/api/dash/media', body),
        HTTP_STATUS.CONFLICT,
        FOLDER_BUSY_CODE,
        { folderIds: [mine] }
      );

      await db
        .update(files)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(files.id, upload));
      const answer = await call(own(), 'DELETE', '/api/dash/media', body);
      expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
      expect(answer.body.data).toMatchObject({
        folderIds: [mine],
        deleted: [upload],
      });
    }
  });

  test('an object the store refuses leaves no folder behind: the row is detached and the sweep finishes it', async () => {
    const top = await seedFolder('Store down');
    const child = await seedFolder('Store down child', top);
    const file = await seedFile({ folderId: child });
    failObjectStore('DeleteObjects');

    const answer = await call(admin(), 'DELETE', '/api/dash/media', {
      folderIds: [top],
      recursive: true,
    });
    expect(answer.status).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toEqual({
      folders: 2,
      folderIds: sorted([top, child]),
      deleted: [],
      pending: [file],
    });
    expect(await remainingFolders([top, child])).toBe(0);
    expect(await fileRow(file)).toEqual({ status: 'deleting', folderId: null });

    clearObjectStoreFailures();
    await sweepFiles();
    expect(await fileRow(file)).toBeNull();
  });

  test('an upload the sweep expired, whose object the store then refused, neither blocks nor strands its folder', async () => {
    const folder = await seedFolder('Expired upload');
    const expired = await seedFile({
      folderId: folder,
      status: 'pending',
      ageMinutes: 25 * 60,
    });
    failObjectStore('DeleteObjects');
    await sweepFiles();
    expect(await fileRow(expired)).toEqual({
      status: 'deleting',
      folderId: null,
    });
    clearObjectStoreFailures();

    const answer = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${folder}`
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(await folderRow(folder)).toBeNull();
  });

  test('rows left deleting inside a folder from before rows were detached are detached, and left to the sweep', async () => {
    const folder = await seedFolder('Legacy deleting');
    const legacy = await seedFiles(FOLDER_RECURSIVE_DELETE_MAX + 1, {
      folderId: folder,
      status: 'deleting',
    });
    const sent: number[] = [];
    const original = r2Module.deleteObjectsFromR2;
    const store = spyOn(r2Module, 'deleteObjectsFromR2').mockImplementation(
      async (params) => {
        sent.push(params.keys.length);
        return original(params);
      }
    );
    try {
      const answer = await call(
        admin(),
        'DELETE',
        `/api/dash/media/folders/${folder}`
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
      expect(answer.body.data).toMatchObject({ deleted: [], pending: [] });
      // Nothing the request was asked for, so none of the store work is its.
      expect(sent).toEqual([]);
    } finally {
      store.mockRestore();
    }
    expect(await folderRow(folder)).toBeNull();
    const [first] = legacy;
    expect(await fileRow(first ?? '')).toEqual({
      status: 'deleting',
      folderId: null,
    });
    let sweep = await sweepFiles();
    while (sweep.hasMore) sweep = await sweepFiles();
    expect(await fileRow(first ?? '')).toBeNull();
  });

  test('a file the sweep finishes while the delete clears its objects is still reported deleted', async () => {
    for (const route of ['mixed', 'file-only'] as const) {
      const file = await seedFile({
        folderId: await seedFolder(`Swept ${route}`),
      });
      const original = r2Module.deleteObjectsFromR2;
      let swept = false;
      const store = spyOn(r2Module, 'deleteObjectsFromR2').mockImplementation(
        async (params) => {
          if (!swept) {
            swept = true;
            await sweepFiles();
          }
          return original(params);
        }
      );
      try {
        const answer =
          route === 'mixed'
            ? await call(admin(), 'DELETE', '/api/dash/media', {
                fileIds: [file],
              })
            : await call(admin(), 'DELETE', '/api/dash/media/files', {
                ids: [file],
              });
        expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
        expect(answer.body.data).toMatchObject({
          deleted: [file],
          pending: [],
        });
      } finally {
        store.mockRestore();
      }
      expect(swept).toBe(true);
      expect(await fileRow(file)).toBeNull();
    }
  });

  test('the body is a selection: empty, oversized and unknown fields are refused', async () => {
    for (const body of [{}, { fileIds: [], folderIds: [] }]) {
      const answer = await call(admin(), 'DELETE', '/api/dash/media', body);
      expect(answer.status).toBe(HTTP_STATUS.UNPROCESSABLE);
      expect(answer.body.detail).toBe(mediaValidationMsg.selectionRequired);
    }
    const tooMany = await call(admin(), 'DELETE', '/api/dash/media', {
      fileIds: Array.from({ length: 30 }, () => generateUuidV7()),
      folderIds: Array.from({ length: 21 }, () => generateUuidV7()),
    });
    expect(tooMany.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(tooMany.body.detail).toBe(mediaValidationMsg.selectionTooMany);
    const unknown = await call(
      admin(),
      'POST',
      '/api/dash/media/delete-preview',
      { folderIds: [generateUuidV7()], force: true }
    );
    expect(unknown.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    const missing = await call(admin(), 'DELETE', '/api/dash/media', {
      folderIds: [generateUuidV7()],
    });
    expectRefusal(missing, HTTP_STATUS.NOT_FOUND, FOLDER_NOT_FOUND_CODE);
  });
});

describe('the delete under real contention', () => {
  test('a file moved out while the delete waited for it survives in its new folder', async () => {
    const doomed = await seedFolder('Contended tree');
    const safe = await seedFolder('Contended refuge');
    const leaving = await seedFile({ folderId: doomed });
    const staying = await seedFile({ folderId: doomed });
    const locked = gate();
    const release = gate();

    const holder = withTransaction(async (tx) => {
      await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.id, leaving))
        .for('update');
      locked.open();
      await release.promise;
      await tx
        .update(files)
        .set({ folderId: safe })
        .where(eq(files.id, leaving));
    });
    await locked.promise;
    const deleting = call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${doomed}?recursive=true`
    );
    await waitForLockWait('for update');
    release.open();
    await holder;

    const answer = await deleting;
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toMatchObject({ deleted: [staying] });
    expect(await fileRow(leaving)).toEqual({
      status: 'active',
      folderId: safe,
    });
    expect(await folderRow(doomed)).toBeNull();
  });

  test('a selected file moved into a selected folder while the delete waited is deleted and audited once', async () => {
    const doomed = await seedFolder('Arrival tree');
    const arriving = await seedFile({ folderId: await seedFolder('Arrival') });
    const locked = gate();
    const release = gate();

    const holder = withTransaction(async (tx) => {
      await tx
        .update(files)
        .set({ folderId: doomed })
        .where(eq(files.id, arriving));
      locked.open();
      await release.promise;
    });
    await locked.promise;
    const deleting = call(admin(), 'DELETE', '/api/dash/media', {
      fileIds: [arriving],
      folderIds: [doomed],
      recursive: true,
    });
    await waitForLockWait('for update');
    release.open();
    await holder;

    const answer = await deleting;
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toMatchObject({
      folderIds: [doomed],
      deleted: [arriving],
    });
    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.recordId, arriving), eq(auditLogs.action, 'DELETE'))
      );
    expect(audits).toHaveLength(1);
  });

  test("an own-scoped delete refuses someone else's file filed in while it waited as absent, before locking it", async () => {
    const mine = await seedFolder('Own contended', null, own().user.userId);
    const selected = await seedFile({
      folderId: await seedFolder('Own elsewhere', null, own().user.userId),
      uploadedBy: own().user.userId,
    });
    const holding = gate();
    const releaseSelected = gate();
    const intruderHeld = gate();
    const releaseIntruder = gate();

    const selectedHolder = withTransaction(async (tx) => {
      await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.id, selected))
        .for('update');
      holding.open();
      await releaseSelected.promise;
    });
    let intruderHolder: Promise<void> = Promise.resolve();
    try {
      await holding.promise;
      const deleting = call(own(), 'DELETE', '/api/dash/media', {
        fileIds: [selected],
        folderIds: [mine],
        recursive: true,
      });
      await waitForLockWait('for update');
      const intruder = await seedFile({
        folderId: mine,
        uploadedBy: other().user.userId,
      });
      intruderHolder = withTransaction(async (tx) => {
        await tx
          .select({ id: files.id })
          .from(files)
          .where(eq(files.id, intruder))
          .for('update');
        intruderHeld.open();
        await releaseIntruder.promise;
      });
      await intruderHeld.promise;
      releaseSelected.open();
      await selectedHolder;

      expectRefusal(await deleting, HTTP_STATUS.NOT_FOUND, FILE_NOT_FOUND_CODE);
      expect(await folderRow(mine)).not.toBeNull();
    } finally {
      releaseSelected.open();
      releaseIntruder.open();
      await selectedHolder;
      await intruderHolder;
    }
  });

  test('a subfolder moved out under the tree lock keeps its files', async () => {
    const doomed = await seedFolder('Locked tree');
    const leaving = await seedFolder('Locked leaving', doomed);
    const kept = await seedFile({ folderId: leaving });
    const locked = gate();
    const release = gate();

    const holder = withTransaction(async (tx) => {
      await lockTree(tx);
      locked.open();
      await release.promise;
      await tx
        .update(folders)
        .set({ parentId: null })
        .where(eq(folders.id, leaving));
    });
    await locked.promise;
    const deleting = call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${doomed}?recursive=true`
    );
    await waitForLockWait('pg_advisory_xact_lock');
    release.open();
    await holder;

    const answer = await deleting;
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toMatchObject({ folderIds: [doomed] });
    expect(await folderRow(leaving)).toEqual({
      parentId: null,
      name: 'Locked leaving',
    });
    expect(await fileRow(kept)).toEqual({
      status: 'active',
      folderId: leaving,
    });
  });

  test('an upload racing the delete waits on the folder lock, then fails its foreign key', async () => {
    const doomed = await seedFolder('Raced folder');
    const paused = gate();
    const resume = gate();
    const original = actorModule.auditManyAs;
    const audit = spyOn(actorModule, 'auditManyAs').mockImplementation(
      async (tx, actor, entries) => {
        if (
          entries.some(
            (entry) =>
              entry.tableName === 'folders' && entry.action === 'DELETE'
          )
        ) {
          paused.open();
          await resume.promise;
        }
        return original(tx, actor, entries);
      }
    );
    try {
      const deleting = call(
        admin(),
        'DELETE',
        `/api/dash/media/folders/${doomed}`
      );
      await paused.promise;
      // What the upload route's insert does, once the folder is held.
      const inserting = seedFile({
        folderId: doomed,
        status: 'pending',
      })
        .then(() => 'inserted')
        .catch((error: unknown) => error);
      await waitForLockWait('insert into "files"');
      resume.open();
      const deleted = await deleting;
      expect(deleted.status).toBe(HTTP_STATUS.OK);
      const outcome = await inserting;
      expect(outcome).not.toBe('inserted');
      expect(String((outcome as Error).cause ?? outcome)).toContain(
        'foreign key'
      );
    } finally {
      audit.mockRestore();
      resume.open();
    }
  });
});

describe('the move', () => {
  test('files and folders move in one transaction, and the answer names only what was re-parented', async () => {
    const from = await seedFolder('Move from');
    const to = await seedFolder('Move to');
    const moving = await seedFolder('Move moving', from);
    const nested = await seedFolder('Move nested', moving);
    const inNested = await seedFile({ folderId: nested });
    const loose = await seedFile({ folderId: from });
    const alreadyThere = await seedFile({ folderId: to });
    const unfiled = await seedFile({ folderId: null });
    await db
      .update(files)
      .set({ unfiledAt: new Date() })
      .where(eq(files.id, unfiled));

    // Unfiled and record-held are the same thing with no owner registered, so
    // the unfiled file is moved with an owner table declared.
    await withSource(PUBLIC_SOURCE, async () => {
      const answer = await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [moving, nested],
        fileIds: [loose, inNested, alreadyThere, unfiled],
        to,
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
      expect(answer.body.data).toMatchObject({
        folderIds: [moving],
        fileIds: sorted([loose, unfiled]),
        unfiledAt: null,
      });
    });
    expect(await folderRow(moving)).toMatchObject({ parentId: to });
    expect(await folderRow(nested)).toMatchObject({ parentId: moving });
    expect(await fileRow(inNested)).toMatchObject({ folderId: nested });
    expect(await fileRow(loose)).toMatchObject({ folderId: to });
    const [adopted] = await db
      .select({ unfiledAt: files.unfiledAt })
      .from(files)
      .where(eq(files.id, unfiled));
    expect(adopted?.unfiledAt).toBeNull();
  });

  test('a move audits every re-parented item in one statement, and nothing it left in place', async () => {
    const from = await seedFolder('Audit move from');
    const to = await seedFolder('Audit move to');
    const moving = [
      await seedFolder('Audit move a', from),
      await seedFolder('Audit move b', from),
    ];
    const movingFiles = await seedFiles(2, { folderId: from });
    const [alreadyThere = ''] = await seedFiles(1, { folderId: to });

    const recorder = recordStatements();
    let answer: Answer;
    try {
      answer = await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: moving,
        fileIds: [...movingFiles, alreadyThere],
        to,
      });
    } finally {
      recorder.stop();
    }
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(recorder.matching(/^insert into "audit_logs"/i)).toHaveLength(1);

    const audited = await db
      .select({
        recordId: auditLogs.recordId,
        changedFields: auditLogs.changedFields,
      })
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.recordId, [
            ...moving,
            ...movingFiles,
            alreadyThere,
          ]),
          eq(auditLogs.action, 'UPDATE')
        )
      );
    expect(sorted(audited.map((row) => row.recordId))).toEqual(
      sorted([...moving, ...movingFiles])
    );
    expect(
      audited.find((row) => row.recordId === moving[0])?.changedFields
    ).toEqual(['parentId']);
  });

  test('a folder cannot move into itself or below itself; the cycle names the folders', async () => {
    const top = await seedFolder('Cycle top');
    const child = await seedFolder('Cycle child', top);
    const grandchild = await seedFolder('Cycle grandchild', child);

    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [top],
        to: grandchild,
      }),
      HTTP_STATUS.UNPROCESSABLE,
      FOLDER_CYCLE_CODE,
      { folderIds: [top] }
    );
    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [child],
        to: child,
      }),
      HTTP_STATUS.UNPROCESSABLE,
      FOLDER_CYCLE_CODE,
      { folderIds: [child] }
    );
    expect(await folderRow(top)).toMatchObject({ parentId: null });
  });

  test('a move that would make the tree too deep names the folders that do not fit', async () => {
    let deepest = await seedFolder('Depth 1');
    for (let level = 2; level < FOLDER_MAX_DEPTH; level++)
      deepest = await seedFolder(`Depth ${level}`, deepest);
    const flat = await seedFolder('Depth flat');
    const tall = await seedFolder('Depth tall');
    await seedFolder('Depth tall child', tall);

    // One more level fits under the deepest folder; two do not.
    const fits = await call(admin(), 'PUT', '/api/dash/media', {
      folderIds: [flat],
      to: deepest,
    });
    expect(fits.status, JSON.stringify(fits.body)).toBe(HTTP_STATUS.OK);
    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [tall],
        to: deepest,
      }),
      HTTP_STATUS.UNPROCESSABLE,
      FOLDER_TOO_DEEP_CODE,
      { folderIds: [tall] }
    );
  });

  test('the destination holds at most its cap of folders, the incoming ones counted', async () => {
    const crowded = await seedFolder('Crowded');
    await db.insert(folders).values(
      Array.from({ length: FOLDER_MAX_CHILDREN - 1 }, (_, index) => ({
        name: `Child ${index}`,
        parentId: crowded,
        createdBy: admin().user.userId,
      }))
    );
    const first = await seedFolder('Incoming one');
    const second = await seedFolder('Incoming two');
    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [first, second],
        to: crowded,
      }),
      HTTP_STATUS.UNPROCESSABLE,
      FOLDER_TOO_MANY_CHILDREN_CODE
    );
    const one = await call(admin(), 'PUT', '/api/dash/media', {
      folderIds: [first],
      to: crowded,
    });
    expect(one.status, JSON.stringify(one.body)).toBe(HTTP_STATUS.OK);
  });

  test('a name taken at the destination, or twice in the selection, is refused case-insensitively by id', async () => {
    const destination = await seedFolder('Names destination');
    await seedFolder('Reports', destination);
    const clash = await seedFolder('REPORTS');
    const twinA = await seedFolder('Twin', await seedFolder('Twin home a'));
    const twinB = await seedFolder('twin', await seedFolder('Twin home b'));
    const fine = await seedFolder('Unique name');

    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [clash, fine],
        to: destination,
      }),
      HTTP_STATUS.CONFLICT,
      FOLDER_NAME_EXISTS_CODE,
      { folderIds: [clash] }
    );
    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [twinA, twinB],
        to: destination,
      }),
      HTTP_STATUS.CONFLICT,
      FOLDER_NAME_EXISTS_CODE,
      { folderIds: sorted([twinA, twinB]) }
    );
    expect(await folderRow(fine)).toMatchObject({ parentId: null });
  });

  test('files cannot go to the root, a missing destination is 404, and an own scope moves only its own', async () => {
    const file = await seedFile({ folderId: await seedFolder('Root bound') });
    const toRoot = await call(admin(), 'PUT', '/api/dash/media', {
      fileIds: [file],
      to: null,
    });
    expect(toRoot.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(toRoot.body.detail).toBe(mediaValidationMsg.filesToRoot);

    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', {
        fileIds: [file],
        to: generateUuidV7(),
      }),
      HTTP_STATUS.NOT_FOUND,
      FOLDER_NOT_FOUND_CODE
    );

    const target = await seedFolder('Own target', null, own().user.userId);
    const theirs = await seedFolder('Their folder', null, other().user.userId);
    expectRefusal(
      await call(own(), 'PUT', '/api/dash/media', {
        folderIds: [theirs],
        to: target,
      }),
      HTTP_STATUS.NOT_FOUND,
      FOLDER_NOT_FOUND_CODE
    );
    const theirFile = await seedFile({
      folderId: target,
      uploadedBy: other().user.userId,
    });
    expectRefusal(
      await call(own(), 'PUT', '/api/dash/media', {
        fileIds: [theirFile],
        to: target,
      }),
      HTTP_STATUS.NOT_FOUND,
      FILE_NOT_FOUND_CODE
    );
  });

  test('a file mid-transition refuses the move with its id', async () => {
    const to = await seedFolder('Busy destination');
    const busy = await seedFile({
      folderId: await seedFolder('Busy source'),
      busy: true,
    });
    expectRefusal(
      await call(admin(), 'PUT', '/api/dash/media', { fileIds: [busy], to }),
      HTTP_STATUS.CONFLICT,
      FILE_BUSY_CODE,
      { fileIds: [busy] }
    );
  });

  test('the file-only route runs the same move and keeps its answer', async () => {
    const to = await seedFolder('Old route destination');
    const file = await seedFile({ folderId: await seedFolder('Old route') });
    const answer = await call(admin(), 'PUT', '/api/dash/media/files', {
      ids: [file],
      folderId: to,
    });
    expect(answer.status).toBe(HTTP_STATUS.OK);
    expect(
      Object.keys(answer.body.data as object).toSorted(compareCodeUnits)
    ).toEqual(['unfiledAt', 'updatedAt']);
    expect(await fileRow(file)).toMatchObject({ folderId: to });
  });

  test('a move answers the timestamp it stored, for real moves, no-ops and both together', async () => {
    const to = await seedFolder('Stamp destination');
    const from = await seedFolder('Stamp source');
    const stale = new Date('2020-01-01T00:00:00.000Z');
    const stamped = async (
      table: typeof files | typeof folders,
      id: string
    ) => {
      const [row] = await db
        .select({ updatedAt: table.updatedAt })
        .from(table)
        .where(eq(table.id, id));
      if (!row) throw new Error('stamped: no row');
      return row.updatedAt.toISOString();
    };
    const cases: Array<{
      path: string;
      body: (ids: { moving: string; staying: string }) => unknown;
    }> = [
      {
        path: '/api/dash/media/files',
        body: ({ moving, staying }) => ({
          ids: [moving, staying],
          folderId: to,
        }),
      },
      {
        path: '/api/dash/media/files',
        body: ({ staying }) => ({ ids: [staying], folderId: to }),
      },
      {
        path: '/api/dash/media',
        body: ({ moving, staying }) => ({ fileIds: [moving, staying], to }),
      },
      {
        path: '/api/dash/media',
        body: ({ staying }) => ({ fileIds: [staying], to }),
      },
    ];
    for (const { path, body } of cases) {
      const moving = await seedFile({ folderId: from });
      const staying = await seedFile({ folderId: to });
      await db
        .update(files)
        .set({ updatedAt: stale })
        .where(inArray(files.id, [moving, staying]));
      const answer = await call(
        admin(),
        'PUT',
        path,
        body({ moving, staying })
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
      const { updatedAt } = answer.body.data as { updatedAt: string };
      expect(updatedAt).toBe(await stamped(files, staying));
    }

    const parked = await seedFolder('Stamp parked', to);
    await db
      .update(folders)
      .set({ updatedAt: stale })
      .where(eq(folders.id, parked));
    const noop = await call(admin(), 'PUT', '/api/dash/media', {
      folderIds: [parked],
      to,
    });
    expect(noop.status, JSON.stringify(noop.body)).toBe(HTTP_STATUS.OK);
    expect(noop.body.data).toMatchObject({ fileIds: [], folderIds: [] });
    expect((noop.body.data as { updatedAt: string }).updatedAt).toBe(
      await stamped(folders, parked)
    );
  });

  test('a move without a destination is refused, not read as the root', async () => {
    const parent = await seedFolder('Kept parent');
    const child = await seedFolder('Kept child', parent);
    const answer = await call(admin(), 'PUT', '/api/dash/media', {
      folderIds: [child],
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
    expect(await folderRow(child)).toMatchObject({ parentId: parent });
  });
});

describe('the move under real contention', () => {
  test('a file move into a folder the mixed move holds does not deadlock with it', async () => {
    // The schedule that deadlocked with folders taken FOR UPDATE: the file
    // move holds its file and wants KEY SHARE on the folder; the mixed move
    // holds the folder and wants the file.
    const moved = await seedFolder('Deadlock folder');
    const destination = await seedFolder('Deadlock destination');
    const file = await seedFile({ folderId: await seedFolder('Deadlock src') });
    const locked = gate();
    const release = gate();

    const fileMove = withTransaction(async (tx) => {
      await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.id, file))
        .for('update');
      locked.open();
      await release.promise;
      await tx.update(files).set({ folderId: moved }).where(eq(files.id, file));
    });
    await locked.promise;
    const mixed = call(admin(), 'PUT', '/api/dash/media', {
      folderIds: [moved],
      fileIds: [file],
      to: destination,
    });
    await waitForLockWait('for update');
    release.open();
    await fileMove;

    const answer = await mixed;
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(await folderRow(moved)).toMatchObject({ parentId: destination });
    expect(await fileRow(file)).toMatchObject({ folderId: destination });
  });

  test('the move locks its files in id order, whatever order the table holds them in', async () => {
    const destination = await seedFolder('Order destination');
    const [first, second] = sorted(
      await seedFiles(2, { folderId: await seedFolder('Order source') })
    );
    if (!first || !second) throw new Error('seedFiles returned too few rows');
    // A rewritten row is stored after the other, so a heap scan meets `second` first.
    await db
      .update(files)
      .set({ displayName: 'rewritten.webp' })
      .where(eq(files.id, first));
    const locked = gate();
    const release = gate();

    const holder = withTransaction(async (tx) => {
      await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.id, first))
        .for('update');
      locked.open();
      await release.promise;
    });
    try {
      await locked.promise;
      const moving = call(admin(), 'PUT', '/api/dash/media', {
        fileIds: [second, first],
        to: destination,
      });
      await waitForLockWait('for update');
      // In id order, the move waits on `first` holding nothing yet.
      const probe = await db
        .execute(
          sql`select id from files where id = ${second}::uuid for update nowait`
        )
        .then(
          () => 'free',
          (error: unknown) => (isLockNotAvailable(error) ? 'held' : error)
        );
      expect(probe).toBe('free');
      release.open();
      await holder;
      const answer = await moving;
      expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    } finally {
      release.open();
      await holder;
    }
  });

  test('an upload into a folder being moved is not held up by the move', async () => {
    const moving = await seedFolder('Moving with upload');
    const destination = await seedFolder('Upload destination');
    const paused = gate();
    const resume = gate();
    const original = actorModule.auditManyAs;
    const audit = spyOn(actorModule, 'auditManyAs').mockImplementation(
      async (tx, actor, entries) => {
        if (entries.some((entry) => entry.tableName === 'folders')) {
          paused.open();
          await resume.promise;
        }
        return original(tx, actor, entries);
      }
    );
    try {
      const moved = call(admin(), 'PUT', '/api/dash/media', {
        folderIds: [moving],
        to: destination,
      });
      await paused.promise;
      // The move holds both folders: the insert must not wait for it.
      const started = performance.now();
      await seedFile({ folderId: moving, status: 'pending' });
      await seedFile({ folderId: destination, status: 'pending' });
      expect(performance.now() - started).toBeLessThan(1000);
      resume.open();
      const answer = await moved;
      expect(answer.status).toBe(HTTP_STATUS.OK);
    } finally {
      audit.mockRestore();
      resume.open();
    }
  });
});
