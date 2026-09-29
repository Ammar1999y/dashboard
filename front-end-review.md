## [High] Saving a role deletes its `media` grants

The server catalog has four pages and nine actions (`packages/shared/src/permissions/constants.ts:36-41, 66-88, 131-180`); the front-end still builds its matrix from a three-page, seven-action copy (`apps/front-end/lib/permissions/constants.ts:25-48, 86-118`). The edit page loads the server's four-page matrix (`apps/front-end/pages/dash/permissions/edit.tsx:80-91`), but `PermissionsChangeHandler` rebuilds the form value from the local catalog on mount (`apps/front-end/components/users/permissions-table/permissions-change-handler.tsx:17-46`, `data.ts:5-15`), so the page sees a three-page array, treats it as a change, and includes it in the PUT (`edit.tsx:101-114`). The handler upserts the pages it received and deletes every row whose page is absent (`apps/back-end/app/api/dash/permissions/[id]/handler.ts:292-308`). One save of any role with media access revokes all of its media grants, and the UI can neither show nor grant `resetTwoFactor` or `publish`.

Delete `apps/front-end/lib/permissions/constants.ts` and build the table from `DEFAULT_PAGE_PERMISSIONS` in `@app/shared/permissions/constants` before the two are ever run together. Repointing the import alone is not enough: `data.ts` and the change handler index rows by position in the local catalog, so both must derive their rows from the shared one.

## [High] Every form validates against copies that have already diverged from the server

The front-end keeps its own `utils/validation/{auth,otp,permissions,rules,constants}.ts`, `lib/permissions/constants.ts`, `lib/data-table/{parsers,config}.ts`, `utils/images/{svg-optimizer,config}.ts`, `utils/time.ts`, `utils/config.ts`, `utils/error-class.ts`, `types/data-table.ts` and the shared subset of `utils/index.ts`, all of which now exist in `packages/shared` in a newer form. The divergence is not hypothetical. The permission catalog is the item above. The verify-side OTP schemas still apply `channelEnabledRefine` (`apps/front-end/utils/validation/otp.ts:162, 174`), as does `changePhoneVerifySchema` (`apps/front-end/utils/validation/auth.ts:231`), while the server removed that refinement from every verify schema for a documented reason (`packages/shared/src/validation/otp.ts:178-183`, `packages/shared/src/validation/auth.ts:273-285`): the client will refuse a valid code delivered on a since-disabled channel that the server would accept. The local parser predates `searchTermLength` and `isTrigramIndexable` entirely (`apps/front-end/lib/data-table/parsers.ts`).

Replace each local module with its `@app/shared/...` import and delete the copy in the same change, so every symbol has one source. Two things must land in the shared package first, or the repoint cannot compile: the form variants and inference types it left commented out (the shared-package review covers them), and the types the front-end derives locally that the shared catalog does not export, `RoleScope`, `OwnScopedAction` and `DashboardPageValues` (`apps/front-end/lib/permissions/constants.ts:23, 52-53, 70`).

## [Medium] The update payloads carry `id` in the body

Both editors put `id` into their JSON bodies (`apps/front-end/pages/dash/permissions/edit.tsx:108`, `apps/front-end/pages/dash/users/edit.tsx:131-133`). The registered body schemas have no `id` (`packages/shared/src/contract.ts:74-79`, `packages/shared/src/validation/permissions.ts:194-196`), and a probe compiled under the front-end's own `tsconfig` confirmed that `RequestBody<'PUT /api/dash/permissions/:id'>` rejects the key. The server tolerates it today only because it spreads the body over the path parameter before validating; the shared-package review asks for that to stop.

Send `id` in the path only, and type each payload as `RequestBody<K>` from `@app/shared/contract` instead of `Partial<UpdatePermissionOutput>`, so the wire shape is checked at the call site rather than discovered as a 422.

## [Medium] The auth client is untyped for the server's additional fields

`apps/front-end/lib/auth/client.ts:4-9` creates the client with no `inferAdditionalFields`, so `roleId` on the user and `metadata` on the session are absent from the client's session type. The commented plan at `:11-27` would import `typeof auth` from the server, the coupling that `packages/shared/src/auth-fields.ts` exists to remove.

Register the plugin with the shared declarations, `inferAdditionalFields({ user: USER_ADDITIONAL_FIELDS, session: SESSION_ADDITIONAL_FIELDS })`, and delete the TODO block.

## [Medium] The hand-written response types import the stale catalog

`apps/front-end/types/permission.ts:2-6` and `apps/front-end/types/user.ts:3` take `DashboardPage`, `PermissionAction`, `RoleScope` and `CUSTOM_ROLE_VALUE` from the local `@/lib/permissions/constants`, so `PermissionClient.permissions` and `UserClient.permissions` cannot express `media`, `resetTwoFactor` or `publish`, and every component typed from them inherits the gap.

Point those imports at `@app/shared/permissions/constants` as part of the catalog replacement. Longer term, derive `PermissionClient` and `UserClient` from types generated out of the OpenAPI document rather than maintaining them by hand; the shared-package review describes that path.

## [Medium] The quick search is admitted by UTF-16 length while the server admits by code points and trigrams

`apps/front-end/utils/query.ts:109-112` sends a search whenever `.length` is at least three; the server counts code points and requires an indexable trigram, and drops a failing term silently by design (`apps/back-end/db/queries/data-table.ts:113-132`, documented at `routes.ts:188`). `!!!`, three emoji, or two emoji are shown as an active search and answered with the unfiltered list. The helpers exist in the shared package (`searchTermLength`, `isTrigramIndexable`, `MIN_SEARCH_LENGTH` at `packages/shared/src/data-table/parsers.ts:42-55, 116-143`).

Use them in the client admission check and in the URL builder; the server needs no change.

## [Medium] The table store parses URL state with the local parsers behind a comment that claims otherwise

`apps/front-end/components/ui/data-table/utils/parsers.ts:1-7` says "re-export from shared lib" and re-exports from `@/lib/data-table/parsers`, the local copy. `apps/front-end/utils/store/data-table-store.ts:9-16, 87-88` reads `parseSortingState`, `parseFiltersState`, `MAX_PAGE` and `MAX_PER_PAGE` through it, and `positiveInt` from the local `utils/index.ts` (`:16`). The shared package keeps the two parsers private (`packages/shared/src/data-table/parsers.ts:209, 345`), which the shared-package review asks to change.

Once they are exported, repoint the store and delete `lib/data-table/parsers.ts`, `lib/data-table/config.ts`, `types/data-table.ts` and the re-export file; nothing in the shared parsers needs the `onDropped` argument on the client.

## [Low] Cleanup the sync must not skip

`hooks/use-upload-file.ts:58` and `components/file-upload/file-upload.tsx:146` call the local `sanitizeSvg`; switching them to `@app/shared/images/svg-optimizer` removes `utils/images/*` and, with it, the front-end's only imports of `svgo` and `isomorphic-dompurify`, which then leave `apps/front-end/package.json` (the parity gate keeps them aligned until they do). The `SVGIconSchema` copy at `apps/front-end/utils/validation/rules.ts:202` has no consumer and goes with its module. `apps/front-end/prettier.config.js` has no `^@app/(.*)$` import group while the back-end's does (`apps/back-end/prettier.config.js:15`); add it before the first `@app/shared` import lands, or the two apps sort the same import differently. Restore `import/no-cycle` and the dependency-direction rules in `apps/front-end/eslint.config.mjs` (`:109-116, 146-192`) and add a `no-restricted-imports` entry for the deleted local paths, so the copies cannot be re-created.
