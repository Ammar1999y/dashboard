import type { UsageSource } from './usage-sources';
import type { Executor } from '@/db';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';
import type { SQL } from 'drizzle-orm';

import { and, inArray, not, sql } from 'drizzle-orm';

import { db } from '@/db';
import { files } from '@/db/schema';
import * as z from 'zod';

import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';
import { MEDIA_USAGE_LIST_MAX } from '@app/shared/validation/constants';

import { uuidList } from './ids';
import { USAGE_SOURCES } from './usage-sources';

interface Usage {
  label: string;
  resource: DashboardPage;
  recordId: string;
  name: string | null;
}

interface FileUsages {
  /** Usages on resources the caller may view, at most `MEDIA_USAGE_LIST_MAX`. */
  visible: Usage[];
  /** Every usage on a resource the caller may view, listed or not. */
  visibleCount: number;
  /** Usages on resources the caller may not view: counted, never named. */
  hidden: number;
}

/*
 * The driver types a raw statement's rows `Record<string, any>` whatever
 * `execute<T>` is given, so each is parsed against what its SQL selects.
 */
const countRowSchema = z.object({ count: z.number() });
const fileIdRowSchema = z.object({ file_id: z.string() });
const usageRowSchema = z.object({
  record_id: z.string(),
  name: z.string().nullable(),
});

/** The pages whose `view` the caller holds — what "used by" may name. */
export function viewablePages(
  permissions: Partial<Record<string, Record<string, boolean>>> | undefined
): Set<DashboardPage> {
  return new Set(
    DASHBOARD_PAGE_NAMES.filter(
      (page) => permissions?.[page]?.['view'] === true
    )
  );
}

async function referenceCount(
  source: UsageSource,
  fileIds: readonly EntityID[],
  executor: Executor
): Promise<number> {
  const [row] = await executor.execute(sql`
    select count(*)::int as count
    from ${sql.identifier(source.table)}
    where ${sql.identifier(source.column)} in (${uuidList(fileIds)})
  `);
  return countRowSchema.parse(row).count;
}

/**
 * The owner row is aliased `owner` for `recordName`: the source row itself, or
 * the `ownerTable` row it points at.
 */
function namedUsages(
  source: UsageSource,
  fileId: EntityID,
  limit: number
): SQL {
  const { ownerTable, recordName } = source;
  const reference = ownerTable ? sql`source` : sql`owner`;
  const from = ownerTable
    ? sql`${sql.identifier(source.table)} as source join ${sql.identifier(ownerTable)} as owner on owner.id = source.${sql.identifier(source.idColumn)}`
    : sql`${sql.identifier(source.table)} as owner`;
  return sql`
    select ${reference}.${sql.identifier(source.idColumn)}::text as record_id,
           (${recordName ?? sql`null`})::text as name
    from ${from}
    where ${reference}.${sql.identifier(source.column)} = ${fileId}::uuid
    order by ${reference}.${sql.identifier(source.idColumn)}
    limit ${limit}
  `;
}

/**
 * Who uses one file, filtered to what `viewable` allows the caller to know.
 * Counts are aggregates and the named list is capped, so a file with many
 * owners costs a bounded read.
 */
export async function fileUsages(
  fileId: EntityID,
  viewable: ReadonlySet<DashboardPage>,
  executor: Executor = db
): Promise<FileUsages> {
  const usages: FileUsages = { visible: [], visibleCount: 0, hidden: 0 };
  for (const source of USAGE_SOURCES) {
    const count = await referenceCount(source, [fileId], executor);
    if (count === 0) continue;
    if (!viewable.has(source.resource)) {
      usages.hidden += count;
      continue;
    }
    usages.visibleCount += count;
    const room = MEDIA_USAGE_LIST_MAX - usages.visible.length;
    if (room === 0) continue;
    const rows = await executor.execute(namedUsages(source, fileId, room));
    for (const row of rows) {
      const usage = usageRowSchema.parse(row);
      usages.visible.push({
        label: source.label,
        resource: source.resource,
        recordId: usage.record_id,
        name: usage.name,
      });
    }
  }
  return usages;
}

/**
 * What a refusal may say about who holds `fileIds`: each viewable source's
 * label once, and how many usages sit on pages the caller may not view.
 */
export async function usageLabels(
  fileIds: readonly EntityID[],
  viewable: ReadonlySet<DashboardPage>,
  executor: Executor = db
): Promise<{ labels: string[]; hidden: number }> {
  const labels = new Set<string>();
  let hidden = 0;
  if (fileIds.length === 0) return { labels: [], hidden };
  for (const source of USAGE_SOURCES) {
    const count = await referenceCount(source, fileIds, executor);
    if (count === 0) continue;
    if (viewable.has(source.resource)) labels.add(source.label);
    else hidden += count;
  }
  return { labels: [...labels], hidden };
}

/** The ids among `fileIds` some registered owner references; no referrer row is read. */
export async function usedIds(
  fileIds: readonly EntityID[],
  executor: Executor = db
): Promise<Set<EntityID>> {
  if (fileIds.length === 0 || !hasUsageSources()) return new Set();
  const rows = await executor
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.id, [...fileIds]), not(unreferenced())));
  return new Set(rows.map((row) => row.id));
}

/**
 * The link boundary decides eligibility from this: a file a private record
 * holds is that record's, whatever the caller may write elsewhere.
 * `fileUsages` answers who may be told.
 */
export async function usageVisibilities(
  fileIds: readonly EntityID[],
  executor: Executor = db
): Promise<Map<EntityID, Set<BucketType>>> {
  const held = new Map<EntityID, Set<BucketType>>();
  for (const id of fileIds) held.set(id, new Set());
  if (fileIds.length === 0) return held;

  for (const source of USAGE_SOURCES) {
    const rows = await executor.execute(sql`
      select distinct ${sql.identifier(source.column)}::text as file_id
      from ${sql.identifier(source.table)}
      where ${sql.identifier(source.column)} in (${uuidList(fileIds)})
    `);
    for (const row of rows)
      held.get(fileIdRowSchema.parse(row).file_id)?.add(source.visibility);
  }
  return held;
}

export function hasUsageSources(): boolean {
  return USAGE_SOURCES.length > 0;
}

/**
 * Correlated to the outer row, so only inside a query over `files`. An
 * unregistered referrer makes it lie (`tests/integration/media-usages.test.ts`
 * guards that; the composite FK still refuses the delete).
 *
 * ⚠️ `false` while no source is registered, the kit's shipped state, so every
 * guard reads "held by someone". The opposite default looks safe and would hand
 * every claimed entity upload to the library and the reaper.
 */
export function unreferenced(): SQL {
  if (!hasUsageSources()) return sql`false`;
  return sql.join(
    USAGE_SOURCES.map(
      (source) =>
        sql`not exists (select 1 from ${sql.identifier(source.table)} where ${sql.identifier(source.column)} = ${files.id})`
    ),
    sql` and `
  );
}

/** Does any PUBLIC owner reference this file? Decides whether it may be unpublished. */
export async function hasPublicUsage(
  fileId: EntityID,
  executor: Executor = db
): Promise<boolean> {
  for (const source of USAGE_SOURCES) {
    if (source.visibility !== 'public') continue;
    const rows = await executor.execute(sql`
      select 1 from ${sql.identifier(source.table)}
      where ${sql.identifier(source.column)} = ${fileId}::uuid
      limit 1
    `);
    if (rows.length > 0) return true;
  }
  return false;
}
