import type { TableQuery } from '@/lib/data-table/query';
import type { ExtendedColumnFilter } from '@app/shared/types/data-table';
import type { BucketType, FileKind } from '@app/shared/validation/enums';

import { calendarDayInZone } from '@app/shared/time';

/** The columns the library sorts files by; folders always come by name. */
export type SortId =
  'displayName' | 'sizeBytes' | 'mimeType' | 'createdAt' | 'updatedAt';

export interface LibrarySort {
  id: SortId;
  desc: boolean;
}

export const DEFAULT_SORT: LibrarySort = { id: 'displayName', desc: false };

/** Files a scrolled listing asks for at a time. */
const LISTING_PAGE_SIZE = 50;

export const SIZE_PRESETS = {
  lt100k: { operator: 'lt', bytes: 100 * 1024 },
  lt500k: { operator: 'lt', bytes: 500 * 1024 },
  gt500k: { operator: 'gt', bytes: 500 * 1024 },
  gt1m: { operator: 'gt', bytes: 1024 * 1024 },
  gt5m: { operator: 'gt', bytes: 5 * 1024 * 1024 },
} as const;

export type SizePreset = keyof typeof SIZE_PRESETS;

export const RECENT_DAYS = [7, 30, 90] as const;

export type RecentDays = (typeof RECENT_DAYS)[number];

/**
 * What the filter panel holds. `since` keeps the day its period starts on as
 * it was when picked, so the listing's key does not move while it is shown.
 */
export interface LibraryFilters {
  kind?: FileKind;
  bucketType?: BucketType;
  mimeType?: string;
  size?: SizePreset;
  since?: { days: RecentDays; from: string };
}

export const NO_FILTERS: LibraryFilters = {};

const DAY_MS = 86_400_000;

/** The calendar day, in the business time zone, `days` before `now`. */
export const recentFrom = (days: RecentDays, now: number) =>
  calendarDayInZone(new Date(now - days * DAY_MS));

/** How many of the panel's groups narrow the listing. */
export const filterCount = (filters: LibraryFilters) =>
  [
    filters.kind,
    filters.bucketType,
    filters.mimeType,
    filters.size,
    filters.since,
  ].filter((value) => value !== undefined).length;

type Filter = ExtendedColumnFilter<Record<string, unknown>>;

const selectFilter = (id: string, value: string): Filter => ({
  id,
  value,
  variant: 'select',
  operator: 'eq',
  filterId: id,
});

/** The panel as the table filters `GET /api/dash/media` reads. */
export function toTableFilters(filters: LibraryFilters): Filter[] {
  const out: Filter[] = [];
  if (filters.kind) out.push(selectFilter('kind', filters.kind));
  if (filters.bucketType)
    out.push(selectFilter('bucketType', filters.bucketType));
  if (filters.mimeType) out.push(selectFilter('mimeType', filters.mimeType));
  if (filters.size !== undefined) {
    const { operator, bytes } = SIZE_PRESETS[filters.size];
    out.push({
      id: 'sizeBytes',
      value: String(bytes),
      variant: 'number',
      operator,
      filterId: 'sizeBytes',
    });
  }
  if (filters.since)
    out.push({
      id: 'createdAt',
      value: filters.since.from,
      variant: 'date',
      operator: 'gte',
      filterId: 'createdAt',
    });
  return out;
}

/** A listing's query, every page but the one fetched. */
export const listingState = (
  sort: LibrarySort,
  filters: LibraryFilters,
  search: string
): Omit<TableQuery, 'page'> => ({
  perPage: LISTING_PAGE_SIZE,
  sort: [{ id: sort.id, desc: sort.desc }],
  filters: toTableFilters(filters),
  joinOperator: 'and',
  search,
});
