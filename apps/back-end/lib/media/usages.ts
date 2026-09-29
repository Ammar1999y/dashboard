import type { UsageSource } from './usage-sources';
import type { Executor } from '@/db';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';
import type { SQL } from 'drizzle-orm';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { files } from '@/db/schema';

import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';

import { USAGE_SOURCES } from './usage-sources';

interface Usage {
  label: string;
  resource: DashboardPage;
  recordId: string;
}

interface UsageSummary {
  /** Usages on resources the caller may view. */
  visible: Usage[];
  /** How many more exist on resources the caller may not view. */
  hidden: number;
}

/**
 * One bound parameter per id rather than one array parameter: the driver
 * encodes a JS array as JSON text, which `::uuid[]` refuses. `fileIds` is
 * bounded by the request schema (`IDS_ARRAY_MAX`).
 */
const usageQuery = (source: UsageSource, fileIds: readonly EntityID[]) => sql`
  select ${sql.identifier(source.column)}::text as file_id,
         ${sql.identifier(source.idColumn)}::text as record_id
  from ${sql.identifier(source.table)}
  where ${sql.identifier(source.column)} in (${sql.join(
    fileIds.map((id) => sql`${id}::uuid`),
    sql`, `
  )})
`;

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

/**
 * The driver returns `Record<string, any>[]` for a raw statement whatever
 * generic is asked for; both columns are cast to `text` in the query, so
 * `String()` is a type statement, not a conversion.
 */
async function* referrers(
  fileIds: readonly EntityID[],
  executor: Executor
): AsyncGenerator<{ source: UsageSource; fileId: string; recordId: string }> {
  for (const source of USAGE_SOURCES) {
    const rows = await executor.execute(usageQuery(source, fileIds));
    for (const row of rows)
      yield {
        source,
        fileId: String(row['file_id']),
        recordId: String(row['record_id']),
      };
  }
}

/**
 * Who uses each file, filtered to what `viewable` allows the caller to know.
 * Hidden usages are counted, not named: the count is enough to explain a 409.
 */
export async function usedBy(
  fileIds: readonly EntityID[],
  viewable: ReadonlySet<DashboardPage>,
  executor: Executor = db
): Promise<Map<EntityID, UsageSummary>> {
  const summaries = new Map<EntityID, UsageSummary>();
  for (const id of fileIds) summaries.set(id, { visible: [], hidden: 0 });
  if (fileIds.length === 0) return summaries;

  for await (const { source, fileId, recordId } of referrers(
    fileIds,
    executor
  )) {
    const summary = summaries.get(fileId);
    if (!summary) continue;
    if (viewable.has(source.resource))
      summary.visible.push({
        label: source.label,
        resource: source.resource,
        recordId,
      });
    else summary.hidden += 1;
  }
  return summaries;
}

/**
 * Which KIND of owner holds each file: the `visibility` of every registered
 * source that references it. The link boundary decides eligibility from this —
 * a file a private record holds is that record's, whatever the caller may write
 * elsewhere — where `usedBy` answers the different question of who may be told.
 */
export async function usageVisibilities(
  fileIds: readonly EntityID[],
  executor: Executor = db
): Promise<Map<EntityID, Set<BucketType>>> {
  const held = new Map<EntityID, Set<BucketType>>();
  for (const id of fileIds) held.set(id, new Set());
  if (fileIds.length === 0) return held;

  for await (const { source, fileId } of referrers(fileIds, executor))
    held.get(fileId)?.add(source.visibility);
  return held;
}

export function hasUsageSources(): boolean {
  return USAGE_SOURCES.length > 0;
}

/**
 * `true` for a `files` row no registered owner references. Correlated to the
 * outer row, so it belongs inside a query over `files` — the "unfiled" scope,
 * the sweep that reaps it, and `mediaGoverned` all rest on it. An unregistered
 * referrer makes it lie, which is what `tests/integration/media-usages.test.ts`
 * exists to prevent; the composite FK still refuses the delete if one slips
 * through.
 *
 * With no source registered — the shipped state of the starter kit — nothing is
 * known about who holds what, so this answers `false` rather than `true`: every
 * guard above it then reads "held by someone", which narrows the media API to
 * the library and leaves the reaper with nothing to collect. The opposite
 * default reads as safe and is not; it would hand the entity boundary and an
 * irreversible deleter every claimed entity upload in a project that has not
 * declared its tables yet.
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
