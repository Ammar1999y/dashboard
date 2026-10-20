/**
 * What the library tells a client about its files and folders: where a file is
 * used and by whom, the figures on every folder, who uploaded what, how long a
 * link lasts and whether it may be cached, the PDF preview, and the limits on
 * publishing.
 *
 * Usage needs owner tables, which the kit ships none of: they are created here
 * in the referrer shape `tests/integration/media-usages.test.ts` requires, and
 * dropped again so that check never sees them.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import type { SignedInSession } from '../helpers/session';
import type { UsageSource } from '@/lib/media/usage-sources';

import { eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { files, folders, users } from '@/db/schema';

import {
  FILE_NOT_FOUND_CODE,
  FOLDER_NOT_FOUND_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MEDIA_USAGE_LIST_MAX } from '@app/shared/validation/constants';

import { generateUuidV7 } from '@/lib/id';
import * as rateLimit from '@/lib/rate-limit';
import * as namesModule from '@/lib/users/names';

import { resetTables } from '../helpers/database';
import { resetRateLimits } from '../helpers/rate-limit';
import { authedRequest, signedInUser } from '../helpers/session';
import {
  createReferrerTable,
  dropReferrerTable,
  PUBLIC_SOURCE,
  refer,
  withSource,
} from '../helpers/usage-registry';

interface Answer {
  status: number;
  body: { message?: string; detail?: string; code?: string; data?: unknown };
}

async function call(
  session: SignedInSession,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<Answer> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await app.handle(authedRequest(session, path, init));
  return { status: response.status, body: await response.json() };
}

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

async function seedFile(options: {
  folderId: string | null;
  status?: 'pending' | 'active';
  kind?: 'image' | 'document';
  mimeType?: string;
  bucketType?: 'public' | 'private';
  sizeBytes?: number;
  uploadedBy?: string | null;
}): Promise<string> {
  const id = generateUuidV7();
  const extension = options.mimeType === 'application/pdf' ? 'pdf' : 'webp';
  await db.insert(files).values({
    id,
    r2Key: `m/2026/10/${id}.${extension}`,
    bucketType: options.bucketType ?? 'private',
    status: options.status ?? 'active',
    kind: options.kind ?? 'image',
    folderId: options.folderId,
    displayName: `report.${extension}`,
    mimeType: options.mimeType ?? 'image/webp',
    sizeBytes: options.sizeBytes ?? 10,
    uploadedBy:
      options.uploadedBy === undefined
        ? admin().user.userId
        : options.uploadedBy,
  });
  return id;
}

interface FileAnswer {
  id: string;
  inUse: boolean;
  uploadedByName: string | null;
  url: string;
}

interface FolderAnswer {
  id: string;
  subfolderCount: number;
  fileCount: number;
  createdByName: string | null;
}

async function listing(folderId: string | null) {
  const answer = await call(
    admin(),
    'GET',
    folderId === null ? '/api/dash/media' : `/api/dash/media?folder=${folderId}`
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
  return answer.body.data as { files: FileAnswer[]; folders: FolderAnswer[] };
}

async function details(session: SignedInSession, id: string) {
  const answer = await call(session, 'GET', `/api/dash/media/files/${id}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
  return answer.body.data as FileAnswer & {
    downloadUrl: string;
    previewUrl: string | null;
    usedBy: Array<{
      label: string;
      resource: string;
      recordId: string;
      name: string | null;
    }>;
    visibleUsages: number;
    hiddenUsages: number;
  };
}

const sessions: { admin?: SignedInSession; viewer?: SignedInSession } = {};
function admin() {
  if (!sessions.admin) throw new Error('admin not seeded');
  return sessions.admin;
}
function viewer() {
  if (!sessions.viewer) throw new Error('viewer not seeded');
  return sessions.viewer;
}

const NAMED_TABLE = '_media_test_named_refs';
const OWNER_TABLE = '_media_test_owner_records';
const LINK_TABLE = '_media_test_owner_links';

const REFERRER_COLUMNS = `
  file_id uuid not null,
  file_status file_status not null default 'active' check (file_status = 'active'),
  foreign key (file_id, file_status) references files (id, status)
    on update no action on delete no action`;

/** Names its records from its own row. */
const NAMED_SOURCE: UsageSource = {
  table: NAMED_TABLE,
  column: 'file_id',
  idColumn: 'id',
  resource: 'users',
  visibility: 'private',
  label: 'سجل مسمى',
  recordName: sql`owner.title`,
};

/** Names its records from the owner row it points at, out of a jsonb document. */
const OWNED_SOURCE: UsageSource = {
  table: LINK_TABLE,
  column: 'file_id',
  idColumn: 'owner_id',
  resource: 'users',
  visibility: 'private',
  label: 'مشروع',
  ownerTable: OWNER_TABLE,
  recordName: sql`owner.translations->'ar'->>'title'`,
};

/** A page the viewer may not see: counted, never named. */
const HIDDEN_SOURCE: UsageSource = {
  ...PUBLIC_SOURCE,
  resource: 'permissions',
  label: 'صلاحيات',
};

async function dropScratchTables(): Promise<void> {
  for (const table of [LINK_TABLE, OWNER_TABLE, NAMED_TABLE])
    await db.execute(sql.raw(`drop table if exists ${table}`));
}

beforeAll(async () => {
  await resetTables();
  await createReferrerTable();
  await dropScratchTables();
  await db.execute(
    sql.raw(
      `create table ${NAMED_TABLE} (id serial primary key, title text, ${REFERRER_COLUMNS})`
    )
  );
  await db.execute(
    sql.raw(
      `create table ${OWNER_TABLE} (id uuid primary key, translations jsonb not null)`
    )
  );
  await db.execute(
    sql.raw(
      `create table ${LINK_TABLE} (id serial primary key, owner_id uuid not null references ${OWNER_TABLE} (id), ${REFERRER_COLUMNS})`
    )
  );
  sessions.admin = await signedInUser();
  sessions.viewer = await signedInUser({
    permissions: { media: { view: true }, users: { view: true } },
  });
}, 30_000);

afterAll(async () => {
  await dropScratchTables();
  await dropReferrerTable();
});

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  setSystemTime();
});

describe('where a file is used', () => {
  test('a listing flags every used file without reading its owners', async () => {
    await withSource(PUBLIC_SOURCE, async () => {
      const folder = await seedFolder('Usage listing');
      const used = await seedFile({ folderId: folder });
      const free = await seedFile({ folderId: folder });
      await refer(used);

      const { files: listed } = await listing(folder);
      expect(
        Object.fromEntries(listed.map((file) => [file.id, file.inUse]))
      ).toEqual({ [used]: true, [free]: false });
      const unused = await details(admin(), free);
      expect(unused.inUse).toBe(false);
    });
  });

  test(`details name at most ${MEDIA_USAGE_LIST_MAX} owners, count the rest, and never name a hidden page`, async () => {
    const folder = await seedFolder('Usage details');
    const file = await seedFile({ folderId: folder });
    const ownerId = generateUuidV7();
    await db.execute(
      sql`insert into ${sql.identifier(NAMED_TABLE)} (title, file_id)
          select 'Record ' || n, ${file}::uuid from generate_series(1, 25) n`
    );
    await db.execute(
      sql`insert into ${sql.identifier(OWNER_TABLE)} (id, translations)
          values (${ownerId}::uuid, jsonb_build_object('ar', jsonb_build_object('title', ${'مشروع الواجهة'}::text)))`
    );
    await db.execute(
      sql`insert into ${sql.identifier(LINK_TABLE)} (owner_id, file_id) values (${ownerId}::uuid, ${file}::uuid)`
    );
    await refer(file);
    await refer(file);

    await withSource(NAMED_SOURCE, () =>
      withSource(OWNED_SOURCE, () =>
        withSource(HIDDEN_SOURCE, async () => {
          const seen = await details(viewer(), file);
          expect(seen.inUse).toBe(true);
          expect(seen.usedBy).toHaveLength(MEDIA_USAGE_LIST_MAX);
          expect(seen.usedBy[0]).toEqual({
            label: NAMED_SOURCE.label,
            resource: 'users',
            recordId: '1',
            name: 'Record 1',
          });
          expect(seen.visibleUsages).toBe(26);
          expect(seen.hiddenUsages).toBe(2);

          // Without the named rows the joined owner fits the list, by name.
          await db.execute(
            sql`delete from ${sql.identifier(NAMED_TABLE)} where file_id = ${file}::uuid`
          );
          const owned = await details(viewer(), file);
          expect(owned.usedBy).toEqual([
            {
              label: OWNED_SOURCE.label,
              resource: 'users',
              recordId: ownerId,
              name: 'مشروع الواجهة',
            },
          ]);
          expect(owned.visibleUsages).toBe(1);
          expect(owned.hiddenUsages).toBe(2);
        })
      )
    );
  });

  test('a source without a name gives its usages none', async () => {
    const folder = await seedFolder('Usage unnamed');
    const file = await seedFile({ folderId: folder });
    await refer(file);
    await withSource(PUBLIC_SOURCE, async () => {
      const seen = await details(admin(), file);
      expect(seen.usedBy).toEqual([
        expect.objectContaining({ label: PUBLIC_SOURCE.label, name: null }),
      ]);
    });
  });
});

describe('folder figures', () => {
  test('every folder answer counts its direct subfolders and active files and names its creator', async () => {
    const parent = await seedFolder('Figures parent');
    const counted = await seedFolder('Figures counted', parent);
    await seedFolder('Figures sub a', counted);
    await seedFolder('Figures sub b', counted);
    await seedFile({ folderId: counted });
    await seedFile({ folderId: counted });
    await seedFile({ folderId: counted, status: 'pending' });
    await db
      .update(users)
      .set({ name: 'Folder Maker' })
      .where(eq(users.id, admin().user.userId));

    const { folders: listed } = await listing(parent);
    expect(listed).toEqual([
      expect.objectContaining({
        id: counted,
        subfolderCount: 2,
        fileCount: 2,
        createdByName: 'Folder Maker',
      }),
    ]);

    const search = await call(
      admin(),
      'GET',
      '/api/dash/media?scope=all&search=Figures%20counted'
    );
    expect(search.status).toBe(HTTP_STATUS.OK);
    expect((search.body.data as { folders: FolderAnswer[] }).folders).toEqual([
      expect.objectContaining({
        id: counted,
        subfolderCount: 2,
        fileCount: 2,
        createdByName: 'Folder Maker',
      }),
    ]);
  });

  test('folder details total the whole subtree; the stats total the library', async () => {
    const before = await call(admin(), 'GET', '/api/dash/media/stats');
    expect(before.status).toBe(HTTP_STATUS.OK);
    const start = before.body.data as {
      folders: number;
      files: number;
      bytes: number;
    };

    const top = await seedFolder('Totals top');
    const child = await seedFolder('Totals child', top);
    const grandchild = await seedFolder('Totals grandchild', child);
    await seedFile({ folderId: top, sizeBytes: 100 });
    await seedFile({ folderId: grandchild, sizeBytes: 1000 });
    await seedFile({ folderId: grandchild, sizeBytes: 5, status: 'pending' });

    const answer = await call(admin(), 'GET', `/api/dash/media/folders/${top}`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toMatchObject({
      id: top,
      subfolderCount: 1,
      fileCount: 1,
      breadcrumbs: [{ id: top, name: 'Totals top' }],
      totals: { folders: 2, files: 2, bytes: 1100 },
    });
    const nested = await call(
      admin(),
      'GET',
      `/api/dash/media/folders/${grandchild}`
    );
    expect(nested.body.data).toMatchObject({
      breadcrumbs: [
        { id: top, name: 'Totals top' },
        { id: child, name: 'Totals child' },
        { id: grandchild, name: 'Totals grandchild' },
      ],
      totals: { folders: 0, files: 1, bytes: 1000 },
    });

    const after = await call(admin(), 'GET', '/api/dash/media/stats');
    expect(after.body.data).toEqual({
      folders: start.folders + 3,
      files: start.files + 2,
      bytes: start.bytes + 1100,
    });

    const missing = await call(
      admin(),
      'GET',
      `/api/dash/media/folders/${generateUuidV7()}`
    );
    expect(missing.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(missing.body.code).toBe(FOLDER_NOT_FOUND_CODE);
    const malformed = await call(
      admin(),
      'GET',
      '/api/dash/media/folders/not-an-id'
    );
    expect(malformed.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(malformed.body.code).toBe(FOLDER_NOT_FOUND_CODE);
  });
});

describe('folder details under a concurrent change', () => {
  test('a delete or a move between its reads leaves the answer one consistent snapshot', async () => {
    const top = await seedFolder('Snapshot top');
    const refuge = await seedFolder('Snapshot refuge');
    const changes = [
      (id: string) =>
        db.update(folders).set({ parentId: refuge }).where(eq(folders.id, id)),
      (id: string) => db.delete(folders).where(eq(folders.id, id)),
    ];
    for (const change of changes) {
      const child = await seedFolder('Snapshot child', top);
      const paused = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = namesModule.userNames;
      const names = spyOn(namesModule, 'userNames').mockImplementation(
        async (...args) => {
          paused.resolve();
          await resume.promise;
          return original(...args);
        }
      );
      try {
        const reading = call(
          admin(),
          'GET',
          `/api/dash/media/folders/${child}`
        );
        await paused.promise;
        await change(child);
        resume.resolve();
        const answer = await reading;
        expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
        expect(answer.body.data).toMatchObject({
          id: child,
          parentId: top,
          breadcrumbs: [
            { id: top, name: 'Snapshot top' },
            { id: child, name: 'Snapshot child' },
          ],
          totals: { folders: 0, files: 0, bytes: 0 },
        });
      } finally {
        names.mockRestore();
        resume.resolve();
      }
    }
  });
});

describe('who uploaded a file', () => {
  test('the name follows the account until it is deleted; a deactivated account keeps it', async () => {
    const uploader = await signedInUser();
    await db
      .update(users)
      .set({ name: 'Uploader Name' })
      .where(eq(users.id, uploader.user.userId));
    const folder = await seedFolder('Uploader');
    const file = await seedFile({
      folderId: folder,
      uploadedBy: uploader.user.userId,
    });
    const nameOf = async () => {
      const listed = await listing(folder);
      return listed.files.find((row) => row.id === file)?.uploadedByName;
    };

    expect(await nameOf()).toBe('Uploader Name');
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, uploader.user.userId));
    expect(await nameOf()).toBe('Uploader Name');
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, uploader.user.userId));
    expect(await nameOf()).toBeNull();
    const detailed = await details(admin(), file);
    expect(detailed.uploadedByName).toBeNull();
  });
});

describe('signed links', () => {
  const WINDOW_MS = 10 * 60_000;

  test('a private image repeats its link for ten minutes and lets the browser keep it for as long', async () => {
    const folder = await seedFolder('Signed images');
    const image = await seedFile({ folderId: folder });
    const document = await seedFile({
      folderId: folder,
      kind: 'document',
      mimeType: 'application/pdf',
    });
    const start = Math.ceil(Date.now() / WINDOW_MS) * WINDOW_MS;
    const urlsAt = async (offsetMs: number) => {
      setSystemTime(new Date(start + offsetMs));
      const { files: listed } = await listing(folder);
      return Object.fromEntries(
        listed.map((file) => [file.id, new URL(file.url)])
      );
    };

    const early = await urlsAt(60_000);
    const late = await urlsAt(WINDOW_MS - 1000);
    const next = await urlsAt(WINDOW_MS + 1000);
    expect(late[image]?.href).toBe(early[image]?.href);
    expect(next[image]?.href).not.toBe(early[image]?.href);

    expect(early[image]?.searchParams.get('X-Amz-Date')).toBe(
      new Date(start).toISOString()
    );
    expect(early[image]?.searchParams.get('X-Amz-Expires')).toBe('4200');
    expect(early[image]?.searchParams.get('response-cache-control')).toBe(
      'private, max-age=600'
    );
    // A document's link is opened, not embedded: nothing to cache.
    expect(early[document]?.searchParams.has('response-cache-control')).toBe(
      false
    );
  });

  test('download and preview links are never cached, and only a PDF has a preview', async () => {
    const folder = await seedFolder('Signed details');
    const pdf = await seedFile({
      folderId: folder,
      kind: 'document',
      mimeType: 'application/pdf',
      bucketType: 'public',
    });
    const image = await seedFile({ folderId: folder });

    const pdfDetails = await details(admin(), pdf);
    const download = new URL(pdfDetails.downloadUrl);
    expect(download.searchParams.get('response-cache-control')).toBe(
      'no-store'
    );
    expect(
      download.searchParams.get('response-content-disposition')
    ).toStartWith('attachment;');
    expect(pdfDetails.previewUrl).not.toBeNull();
    const preview = new URL(pdfDetails.previewUrl ?? '');
    // Signed on the store, never the public domain, though the file is public.
    expect(preview.origin).toBe(new URL(download).origin);
    expect(pdfDetails.url).toStartWith(process.env.R2_PUBLIC_URL ?? '');
    expect(preview.searchParams.get('response-content-type')).toBe(
      'application/pdf'
    );
    expect(preview.searchParams.get('response-cache-control')).toBe('no-store');
    expect(
      preview.searchParams.get('response-content-disposition')
    ).toStartWith('inline;');

    const imageDetails = await details(admin(), image);
    expect(imageDetails.previewUrl).toBeNull();
  });
});

describe('codes the routes answer', () => {
  test('a malformed or missing file id is FILE_NOT_FOUND with no data', async () => {
    for (const id of ['not-an-id', generateUuidV7()]) {
      const answer = await call(admin(), 'GET', `/api/dash/media/files/${id}`);
      expect(answer.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(answer.body.code).toBe(FILE_NOT_FOUND_CODE);
      expect(answer.body.data).toBeUndefined();
    }
  });

  test('an upload whose folder is deleted while it is processed answers FOLDER_NOT_FOUND, not 500', async () => {
    const folder = await seedFolder('Vanishing');
    const original = rateLimit.enforceRateLimit;
    const charge = spyOn(rateLimit, 'enforceRateLimit').mockImplementation(
      async (options) => {
        if (options.scope === 'upload.document')
          await db.delete(folders).where(eq(folders.id, folder));
        return original(options);
      }
    );
    try {
      const form = new FormData();
      form.append(
        'file',
        new File(['%PDF-1.4\n%vanishing\n'], 'gone.pdf', {
          type: 'application/pdf',
        })
      );
      const answer = await call(
        admin(),
        'POST',
        `/api/dash/media/files?folder=${folder}`,
        form
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(
        HTTP_STATUS.NOT_FOUND
      );
      expect(answer.body.code).toBe(FOLDER_NOT_FOUND_CODE);
    } finally {
      charge.mockRestore();
    }
  });
});

describe('publishing limits', () => {
  test('publish allows 60 a minute and unpublish 10, each on its own budget', async () => {
    const folder = await seedFolder('Limits');
    const isPublic = await seedFile({ folderId: folder, bucketType: 'public' });
    const isPrivate = await seedFile({ folderId: folder });

    const statusOf = async (path: string) => {
      const answer = await call(admin(), 'POST', path);
      return answer.status;
    };
    const unpublish = `/api/dash/media/files/${isPrivate}/unpublish`;
    const publish = `/api/dash/media/files/${isPublic}/publish`;

    // Already where they are asked to go: each call is a no-op success.
    for (let attempt = 0; attempt < 10; attempt++)
      expect(await statusOf(unpublish)).toBe(HTTP_STATUS.OK);
    expect(await statusOf(unpublish)).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);

    for (let attempt = 0; attempt < 60; attempt++)
      expect(await statusOf(publish)).toBe(HTTP_STATUS.OK);
    expect(await statusOf(publish)).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
  });
});
