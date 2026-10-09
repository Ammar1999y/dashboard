import type { DashboardPage } from '@app/shared/permissions/constants';
import type { BucketType } from '@app/shared/validation/enums';
import type { SQL } from 'drizzle-orm';

/**
 * ⚠️ No runtime `@/` import: `scripts/migrate.ts` imports this by relative path
 * and runs without the server's secrets, which `@/db` requires.
 *
 * Every table referencing `files.id` MUST be declared here
 * (`tests/integration/media-usages.test.ts` fails otherwise): the registry
 * answers "used by", the delete 409, and whether a public usage blocks
 * `unpublish`.
 *
 * Every field comes from THIS file, never a request, which is what makes
 * `sql.identifier` on the names and the raw `recordName` expression safe.
 */
export interface UsageSource {
  /** The referencing table, e.g. `project_images`. */
  table: string;
  /** Its `file_id` column. */
  column: string;
  /** The column that identifies the OWNER record, e.g. `project_id`. */
  idColumn: string;
  /** The dashboard page whose `view` grant lets a caller see this usage. */
  resource: DashboardPage;
  /** Whether owners reached through this source are published content. */
  visibility: BucketType;
  /** Shown to the caller in "used by" and in the delete refusal. */
  label: string;
  /**
   * The owner's table when it is not `table` itself, joined on
   * `owner.id = <table>.<idColumn>`.
   */
  ownerTable?: string;
  /**
   * The owner record's display name as SQL over the alias `owner`, e.g.
   * `owner.translations->'ar'->>'title'`. Without it a usage has no name.
   */
  recordName?: SQL;
}

/**
 * Empty in the starter kit. A project adds a row per owner table, e.g.
 *
 *   { table: 'projects', column: 'cover_image_id', idColumn: 'id',
 *     resource: 'projects', visibility: 'public', label: 'صورة مشروع' }
 */
export const USAGE_SOURCES: readonly UsageSource[] = [];

/**
 * `table.column` for every registered reference, the key
 * `referrerContractViolations` matches a catalog foreign key against.
 */
export const registeredFileColumns = (): ReadonlySet<string> =>
  new Set(USAGE_SOURCES.map((source) => `${source.table}.${source.column}`));
