/**
 * `handleFolderForeignKeyViolation` claims the one constraint that means "the
 * destination folder is gone", matched by name like its users sibling. The
 * file routes it guards also write audit rows, whose actor FK failing is a
 * server fault, not a missing folder.
 */
import { beforeAll, expect, test } from 'bun:test';

import { db } from '@/db';
import { getConstraintName } from '@/db/errors';
import { auditLogs, files } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';

import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';

async function provoke(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the write to fail, and it succeeded');
}

beforeAll(async () => {
  await resetTables();
});

test('a file filed into a folder that does not exist is the folder 404', async () => {
  const thrown = await provoke(() =>
    db.insert(files).values({
      bucketType: 'public',
      kind: 'image',
      mimeType: 'image/webp',
      r2Key: `fk/${generateUuidV7()}.webp`,
      displayName: 'orphan.webp',
      folderId: generateUuidV7(),
    })
  );

  expect(getConstraintName(thrown)).toBe('files_folder_id_folders_id_fk');
  const output = handleFolderForeignKeyViolation(thrown);
  expect(output?.status).toBe(HTTP_STATUS.NOT_FOUND);
  expect(output?.body).toMatchObject({ detail: mediaMsg.folderNotFound });
});

test('any other foreign-key violation is left to the caller', async () => {
  const thrown = await provoke(() =>
    db.insert(auditLogs).values({
      userId: generateUuidV7(),
      userEmail: 'gone.actor@gmail.com',
      action: 'UPDATE',
      tableName: 'files',
      recordId: generateUuidV7(),
    })
  );

  expect(getConstraintName(thrown)).toBe('audit_logs_user_id_users_id_fk');
  expect(handleFolderForeignKeyViolation(thrown)).toBeUndefined();
});
