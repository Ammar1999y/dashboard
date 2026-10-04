import type { EntityID } from '@app/shared/types';

/** A create answers with what the server generated; the rest was sent. */
export interface CreatedResponse {
  id: EntityID;
}

/** An update answers with the new timestamp only. */
export interface UpdatedResponse {
  updatedAt: string;
}

/** What the server keeps beside a row's own fields, and always sends. */
export interface StoredRow {
  id: EntityID;
  createdAt: string;
  updatedAt: string;
}
