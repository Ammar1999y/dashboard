/**
 * ⚠️ Switching this between `string` (UUID v7) and `number` is a schema-wide
 * migration, not a type edit: every primary, foreign and logical id column in
 * `db/schema.ts`, `validID` and `extractIdFromUrl` in `utils.ts`, and the id
 * schemas in `validation/rules.ts` and `validation/media.ts` change with it.
 */
export type EntityID = string;
