import type { AuditActor } from './actor';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { isForeignKeyViolation } from '@/db/errors';
import { files } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';

import { purgeUrls } from '@/lib/cloudflare/purge';
import {
  deleteObjectsFromR2,
  ENABLED_VISIBILITIES,
  getPublicUrl,
  hasPublicUrl,
} from '@/lib/r2/client';

import { logSanitized } from '@/utils/log';

import { auditManyAs } from './actor';
import { fileNotFound } from './errors';
import { distinctIds } from './ids';
import { unreferenced } from './usages';

/**
 * Must cover an entity form left open overnight: lowering it deletes uploads
 * out from under the open form. Also reaps a library upload whose activation
 * never ran or whose object write failed ambiguously.
 */
const PENDING_FILE_TTL = '24 hours';

const SWEEP_BATCH_SIZE = 1000;

/**
 * Counted from the pass that first saw the file unfiled (`unfiled_at`), because
 * the owner deletion that orphans it touches no row here. The `unfiled` listing
 * exposes this number.
 */
export const UNFILED_RETENTION_DAYS = 7;
/** Reaped per pass: each one is a statement and an object delete. */
const UNFILED_REAP_BATCH = 100;

/**
 * Shared by the listing, the stamp and the reaper so they agree on which rows
 * are on the clock. Matches nothing until a project registers its owner tables
 * (`unreferenced()` fails closed).
 */
export const unfiledNow = () =>
  and(eq(files.status, 'active'), isNull(files.folderId), unreferenced());

/**
 * Attaches pending uploads to their owner, in the owner's transaction;
 * `attachFiles` in `./link.ts` is the usual way in. The caller inserts its
 * referrer rows AFTER this: the composite FK needs the status flip.
 */
export async function claimFiles(
  tx: Tx,
  params: { ids: readonly EntityID[]; actor: AuditActor }
): Promise<EntityID[]> {
  const ids = distinctIds(params.ids);
  if (ids.length === 0) return [];
  const { actor } = params;
  const claimed = await tx
    .update(files)
    .set({ status: 'active' })
    .where(
      and(
        inArray(files.id, ids),
        eq(files.status, 'pending'),
        eq(files.uploadedBy, actor.userId)
      )
    )
    .returning({ id: files.id });
  if (claimed.length !== ids.length)
    throw fileNotFound(HTTP_STATUS.UNPROCESSABLE);

  await auditManyAs(
    tx,
    actor,
    claimed.map((row) => ({
      action: 'UPDATE' as const,
      tableName: 'files',
      recordId: row.id,
      oldData: { status: 'pending' },
      newData: { status: 'active' },
    }))
  );
  return claimed.map((row) => row.id);
}

export interface DoomedRow {
  id: string;
  r2Key: string;
  bucketType: BucketType;
}

/**
 * Objects first, then rows, for rows already `deleting`; a re-run is clean
 * because `DeleteObjects` reports a missing key as deleted. A row is retained
 * while any delete or configured purge it needs failed: a copy still served
 * from the edge is not gone.
 *
 * ⚠️ EVERY enabled bucket, not the one the row names: a transition lost to the
 * sweep can leave a copy opposite that only this row still names. Safe blind,
 * since `ux_files_r2_key` gives one key one row.
 * ⚠️ A row whose own bucket is not configured is retained: its objects are
 * still stored.
 */
export async function finishDeleting(
  rows: readonly DoomedRow[]
): Promise<{ removed: string[]; retained: string[] }> {
  if (rows.length === 0) return { removed: [], retained: [] };
  const keys = rows.map((row) => row.r2Key);

  const goneFrom = new Map<BucketType, ReadonlySet<string>>();
  for (const bucketType of ENABLED_VISIBILITIES) {
    try {
      const outcome = await deleteObjectsFromR2({ keys, bucketType });
      goneFrom.set(bucketType, new Set(outcome.deleted));
    } catch {
      // Count only. A key is a row id, but the error text is provider-controlled.
      logSanitized('error', {
        msg: 'media.delete objects failed',
        bucketType,
        count: keys.length,
      });
      goneFrom.set(bucketType, new Set());
    }
  }

  // Public rows only: a copy opposite a private row was never published, since
  // a delete refuses a file mid-transition and a transition clears its marker
  // only once that copy is deleted and purged (`removeStaleCopy`).
  const unpurged = new Set<string>();
  const publicGone = goneFrom.get('public');
  if (publicGone && hasPublicUrl()) {
    const urls = rows
      .filter((row) => row.bucketType === 'public' && publicGone.has(row.r2Key))
      .map((row) => getPublicUrl(row.r2Key));
    const purge = await purgeUrls(urls);
    for (const url of purge.failed) unpurged.add(url);
  }

  const cleared = goneFrom.values().toArray();
  const addressable = (row: DoomedRow) =>
    ENABLED_VISIBILITIES.has(row.bucketType);
  const stranded = rows.filter((row) => !addressable(row));
  if (stranded.length > 0)
    logSanitized('error', {
      msg: 'media.delete row names a bucket this deployment cannot address',
      buckets: [...new Set(stranded.map((row) => row.bucketType))],
      count: stranded.length,
    });

  const done = rows.filter(
    (row) =>
      addressable(row) &&
      cleared.every((gone) => gone.has(row.r2Key)) &&
      !(hasPublicUrl() && unpurged.has(getPublicUrl(row.r2Key)))
  );

  const settled = new Set(done.map((row) => row.id));
  const retained = rows
    .filter((row) => !settled.has(row.id))
    .map((row) => row.id);
  if (done.length === 0) return { removed: [], retained };

  const removed = done.map((row) => row.id);
  // A row already gone was finished by a racing sweep; its objects are gone
  // either way, and `deleting` never reverts, so it is removed all the same.
  await db
    .delete(files)
    .where(and(inArray(files.id, removed), eq(files.status, 'deleting')));
  return { removed, retained };
}

export interface FileSweepCount {
  removed: number;
  unfiled: { stamped: number; reaped: number };
  hasMore: boolean;
  degraded: boolean;
}

/** Two statements, so the stamp can use `unfiledNow()` itself. */
async function stampUnfiled(): Promise<number> {
  await db
    .update(files)
    .set({ unfiledAt: null })
    .where(
      sql`${files.unfiledAt} is not null and not (${files.folderId} is null and (${unreferenced()}))`
    );
  const stamped = await db
    .update(files)
    .set({ unfiledAt: sql`now()` })
    .where(and(unfiledNow(), isNull(files.unfiledAt)))
    .returning({ id: files.id });
  return stamped.length;
}

/**
 * One statement per row, so an FK refusal leaves its neighbours marked. A
 * refusal means a referrer missing from the registry, which
 * `tests/integration/media-usages.test.ts` exists to catch.
 */
async function reapUnfiled(): Promise<{
  reaped: number;
  refused: number;
  hasMore: boolean;
}> {
  const cutoff = sql`now() - ${`${UNFILED_RETENTION_DAYS} days`}::interval`;
  const due = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(unfiledNow(), isNull(files.transition), lt(files.unfiledAt, cutoff))
    )
    .limit(UNFILED_REAP_BATCH);

  let reaped = 0;
  let refused = 0;
  for (const { id } of due) {
    try {
      const marked = await db
        .update(files)
        .set({ status: 'deleting' })
        .where(
          and(
            eq(files.id, id),
            unfiledNow(),
            isNull(files.transition),
            lt(files.unfiledAt, cutoff)
          )
        )
        .returning({ id: files.id });
      reaped += marked.length;
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      refused += 1;
    }
  }
  if (refused > 0)
    logSanitized('error', {
      msg: 'media.unfiled reap refused by an unregistered referrer',
      count: refused,
    });
  return { reaped, refused, hasMore: due.length === UNFILED_REAP_BATCH };
}

/**
 * `degraded` is only a retained row or a refused reap, so the job can tell a
 * store outage from an ordinary backlog (`hasMore`).
 */
export async function sweepFiles(): Promise<FileSweepCount> {
  const expiredBefore = sql`now() - ${PENDING_FILE_TTL}::interval`;
  const expired = () =>
    and(
      eq(files.status, 'pending'),
      isNull(files.transition),
      lt(files.createdAt, expiredBefore)
    );
  const marked = await withTransaction(async (tx) => {
    const candidates = tx
      .select({ id: files.id })
      .from(files)
      .where(expired())
      .limit(SWEEP_BATCH_SIZE);
    // A `pending` row can have no referrer, so marking it cannot hit the
    // composite FK. Repeated on the UPDATE: under Read Committed only the outer
    // WHERE is re-checked against a row a racing claim just made active, so
    // without it the sweep marks a referenced file and throws on the FK.
    // Detached like every `deleting` row, so an object R2 then refuses never
    // holds its folder.
    return tx
      .update(files)
      .set({ status: 'deleting', folderId: null })
      .where(and(inArray(files.id, candidates), expired()))
      .returning({ id: files.id });
  });

  const stamped = await stampUnfiled();
  const reap = await reapUnfiled();

  const doomed = await db
    .select({ id: files.id, r2Key: files.r2Key, bucketType: files.bucketType })
    .from(files)
    .where(eq(files.status, 'deleting'))
    .limit(SWEEP_BATCH_SIZE);

  const { removed, retained } = await finishDeleting(doomed);
  return {
    removed: removed.length,
    unfiled: { stamped, reaped: reap.reaped },
    hasMore:
      marked.length === SWEEP_BATCH_SIZE ||
      doomed.length === SWEEP_BATCH_SIZE ||
      reap.hasMore ||
      retained.length > 0,
    degraded: retained.length > 0 || reap.refused > 0,
  };
}
