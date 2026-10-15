# Plan: media library back end for the new file manager

Status: **back end implemented, uncommitted (2026-10-07).** Phases 1–7 are in `apps/back-end` and `packages/shared`; the front-end handoff below is still open, and so is the later release that removes the old file-only routes. Where the code departs from this plan, "Implementation notes" says how and why.

- Two reviews (`codex`, `claude`, 31 findings) were verified against the code and merged; the review log is at the end.
- All Phase 0 probes passed against the live R2 buckets.
- Every decision is settled. The owner delegated the open ones on 2026-10-06: where the reviewers and this plan agreed on the better option, it was adopted.

## Implementation notes (2026-10-07)

Where the code lives:

- `lib/media/errors.ts`: the refusal factories. `lib/media/selection.ts`: the shared normalisation, the mixed move, the delete admission and its preview. `lib/media/signing.ts`: the signing window, with no database import so a child process can run it against the real presigner. `lib/users/names.ts`: `userNames`.
- Tests: `tests/integration/media-selection.test.ts` (delete, preview, move, the real-transaction schedules), `tests/integration/media-details.test.ts` (usage, figures, names, links, PDF preview, the upload race, limits), `tests/unit/presign-window.test.ts` with `tests/fixtures/_presign-child.ts`.

Live check, 2026-10-07: the real routes ran against both R2 buckets and a throwaway database, and all 28 checks passed. Covered: upload, links stable within a window, the private-image cache header, `no-store` on download and preview even over a public object's stored headers, the inline PDF preview on the S3 endpoint with no framing headers, a link valid at 69 minutes and refused at 71, publish and unpublish, an abandoned upload deleted with its folder, and the mixed delete. Both buckets were left empty.

Departures from the plan, each found while building it:

1. **`apiSuccess` takes `const T`.** Widening `ErrorBody.data` to `MediaRefusalData | null` made TypeScript infer every literal success (`{ reset: true }`, `{ verified: true }`) as `boolean`, through the error branch of `RouteOutput`; seven unrelated handlers stopped compiling.
2. **A `deleting` row counts as governed for the delete.** Detaching marked rows made a retried delete answer 404 in a kit without owner tables and 409 with them. A `deleting` row can have no referrer, so it hides nothing; the retry keeps answering `FILE_BUSY` in every configuration.
3. **An unregistered referrer still answers `FILE_IN_USE`**, without `data`, since nothing can name the file. Only a foreign-key failure of the marking statement means "in use"; any other in the same transaction (an audit row whose actor was just deleted, say) is a fault and stays a 500. The old code mapped every one.
4. **A file filed into the tree between the walk and the folder locks** is committed by then; the delete locks it `NOWAIT` and answers `FILE_BUSY` if someone holds it, so it never waits on a writer that may be waiting on the folders.
5. **Without `recursive`, `FOLDER_NOT_EMPTY` comes before the cap**, from an exact per-folder query: nothing inside is deleted, so a full folder is refused as full, never as too large.
6. **`FOLDER_BUSY` names the folder holding the fresh upload**, which inside a recursive delete can be a descendant of the selected folder.
7. **`FILE_BUSY` names its file on the single-file routes too** (rename, publish, unpublish), so their 409 publishes `MediaRefusalEnvelope`. `POST /api/dash/media/folders` cannot name a folder that does not exist yet, so its refusals keep `ErrorEnvelope`: an entry names the codes that carry ids at a status in its `errors` (`codesWithIds`), and the create declares none there. `FILE_IN_USE` may still come without ids where it is declared with them (`idsAreOptional`, `packages/shared/src/responses/media.ts`), per item 3.
8. **`PUT /api/dash/media/files` now takes the tree lock**, because it runs the mixed move core.
9. **Ids in every refusal and answer are sorted**, so one blocked selection answers the same body every time.
10. **`reports/review-findings.md` lost #2, #6 and #15–#19 without renumbering**, because other documents cite its entries by number.
11. **An unfinished upload is outside the scope check.** Under `deleteOwn`, another user's upload in the caller's folder answers `FOLDER_BUSY` while fresh and goes with the folder once abandoned. Scoping it answered 404 and kept the 24-hour block.
12. **One rate-limit budget per operation:** the deprecated and the new move share `media.move`, and every delete route shares `media.delete`.
13. **`svgOptimizeFailed` is `FILE_CONTENT_REFUSED`**, not `IMAGE_NOT_COMPRESSIBLE`. Markup the sanitiser accepted can still fail svgo, and no smaller size would help.
14. **A move writes every selected item**, moved or already at the destination, as the file-only route always did. `updatedAt` is then the value each of them stores. `to` is required: a missing one is refused, not read as the root.
15. **Rows already `deleting` in a deleted folder are only detached.** The sweep removes their objects, so the request's store work stays within the cap.
16. **A file a racing sweep finished counts as deleted**, since its objects are gone either way.
17. **Folder details read one repeatable-read snapshot.**

Inputs:

- the front end's request: `design-prototypes/file-manager/backend-request.md`;
- its prototype: `design-prototypes/file-manager/b-studio.html`.

## Decisions

| Phase | Request item              | Decision                                                                                                                                                                                                                             |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | #1 error codes            | A stable code on every library refusal, upload refusals included (by family). Every refusal of a bulk route carries the ids that blocked it.                                                                                         |
| 2     | #3 where used             | `inUse` on every file; owner record names in file details, as a bounded list. No flag on folders.                                                                                                                                    |
| 3     | #5 folder figures, delete | Direct counts on every folder; a storage total; recursive totals in folder details only; the mixed delete and its preview. The delete is all-or-nothing in the database, and an upload abandoned for 10 minutes no longer blocks it. |
| 4     | #2 stable URLs            | Signing in 10-minute windows: a link stays the same for 10 minutes and is valid for 60–70 minutes. Private **images** are cacheable for 10 minutes. Download and preview links are `no-store`.                                       |
| 5     | #6 uploader               | Name only; there is no avatar column. Visible to every `media.view` holder.                                                                                                                                                          |
| 6     | #4 bulk move, limits      | Mixed file and folder move. No bulk publish endpoint. Publish goes to 60 per minute; unpublish stays at 10. The old file-only bulk routes stay until the front end has switched.                                                     |
| 7     | #7 PDF preview            | An inline `previewUrl`, signed on R2's S3 endpoint only, `no-store`.                                                                                                                                                                 |
| —     | #8, #9, #10               | Dropped: duplicate warning, ZIP download, replacing a file's content.                                                                                                                                                                |

Also out of scope, by the front end's own list: trash, favourites, recent files, tags, share links, thumbnails, chunked uploads, realtime updates, files at the root, a folder tree, subfolder search and copy.

## Changed since the answers the front end has

1. **No back-end setting for the PDF iframe.** The front end's CSP is defined but switched off (`apps/front-end/next.config.js`), and `next.config.js` can read the R2 host at build time.
2. **A deleted uploader is not `uploaded_by = null`.** Users are soft-deleted, so the row and name stay; the name comes back `null` for a soft-deleted user.
3. **The delete preview takes the delete's own body**, `recursive` included.
4. **The old file-only bulk routes are retired in a later release,** after the front end has switched.
5. **Folder details and the storage total are new routes.**
6. **Links change every 10 minutes and are valid for 60–70 minutes,** not 1–2 hours. Only private images are cached; download and preview links never are.
7. **A delete happens entirely or not at all.** The answer lists every deleted folder id.
8. **An upload abandoned for 10 minutes no longer blocks deleting its folder.** It is deleted with the folder. A fresh one still answers `FOLDER_BUSY`, naming the folder.
9. **A move ignores an item whose ancestor is also selected.** The answer lists the ids actually moved.
10. **Codes:** upload refusals get family codes, every refusal of a bulk route carries ids, and refusals with ids use their own envelope component.
11. **The usage list in file details is capped,** with a total count.
12. **Publish is limited to 60 per minute, unpublish to 10.**

## What exists today (verified 2026-10-06)

**Errors**

- `CustomError(message, status?, code?)` lives in `packages/shared/src/error-class.ts`.
  - `apiError` forwards `code` and always sends `data: null` (`lib/http/response.ts:108-119`).
  - `ErrorBody.data` is typed `null` (`lib/http/contract.ts:94-99`).
  - The response check skips every failure (`lib/http/response-check.ts`).
- No media refusal carries a code. The message and status pairs are written out at about 30 sites:
  - `lib/media/{files,folders,lifecycle,link,visibility,upload}.ts`;
  - `lib/media/image/{optimize,process,svg}.ts`;
  - `handleFolderForeignKeyViolation` (`lib/http/constraint-errors.ts`).
- `requireId` (`lib/http/input.ts:57`) has 16 callers: 7 pass their own refusal (6 media handlers, plus `app/api/dash/users/[id]/two-factor/handler.ts:66-70`), and 9 use the default.
- `POST /api/dash/media/files` has no `mapError`. A folder deleted mid-upload fails the unwrapped insert's foreign key, and the route answers 500.
- Every error response references `ErrorEnvelope` (`lib/http/openapi/envelope.ts`), with `data: null`. Every media 409 has a generic description (`route-operations.ts`).
- The front end parses `data: z.unknown()`, but `failure()` drops it (`apps/front-end/lib/api/fetch.ts`).
- Existing codes are one `*_CODE` constant each in `packages/shared/src/error-codes.ts`. `otp_proof_throttle` (`lib/otp/throttle.ts:84`) is a lowercase outlier: reported, not in scope.

**Deletes**

- **A stale plan can delete a moved-out file** (`review-findings.md` #2).
  - The recursive delete commits its plan, then calls `deleteFiles` with the captured ids (`lib/media/lifecycle.ts:302-344`).
  - `deleteFiles` does not re-check folder membership.
  - `updateFile` and `moveFiles` take no tree lock (`lib/media/files.ts:143-217`).
- **Folders can be stranded** (#6). A row whose object R2 refused stays `deleting` with its `folder_id`. The folder phase keeps the folders (`lifecycle.ts:353-362`), and a retry answers `FOLDER_BUSY` (`:328-329`) until the nightly sweep.
- **The recursive delete reads the whole subtree** before it checks the cap (`:305-325`, #17).
- **A failed library upload's `pending` row** blocks deleting its folder for up to 24 hours, while listings show the folder as empty (#18).
- **Only `lifecycle.ts` (by status) and `link.ts` (by id) read `deleting` rows.** No constraint ties `folder_id` to `status`.
- **The sweep marks expired `pending` rows `deleting` without detaching them** (`sweepFiles`, `lifecycle.ts:473-476`). If R2 then refuses the object, the row stays `deleting` inside its folder.
- **The worst case for an R2 write is under a minute:** 3 attempts, each with a 3 s connect and a 15 s request timeout (`lib/r2/client.ts:49-68`). `TRANSITION_STALE_AFTER` (`lib/media/visibility.ts:41`, 10 minutes) already treats a stuck transition as abandoned on that basis.

**Moves and locks**

- `updateFile` and `moveFiles` lock files `FOR UPDATE`, then take `KEY SHARE` on the destination through the foreign key.
- `lockParent` and `lockFolderFor` take `FOR UPDATE` (`folders.ts:236,257`).
- Reviewer B ran a two-connection PostgreSQL probe:
  - folders `FOR UPDATE` before files deadlocks with that order;
  - `FOR NO KEY UPDATE` lets both transactions commit;
  - an upload into a folder held `FOR UPDATE` waited 741 ms, against 2 ms under `NO KEY UPDATE`.
- `UPDATE folders SET parent_id` takes only `NO KEY UPDATE`.
- `updateFolder`'s cycle check loads the whole moved subtree under `lockTree` (`folders.ts:171-209,389`, #16).

**Usage**

- The registry is empty (`lib/media/usage-sources.ts:37`). `usageQuery` returns every referrer row with no bound (`lib/media/usages.ts:35-45`, #19).

**Signing, caching and R2 (live probes 2026-10-06)**

- `getPresignedUrl` (`lib/r2/client.ts:377`) clamps lifetimes to 7 days. Its only callers are `fileUrl` and `downloadUrl` (`lib/media/files.ts:255-278`).
- The installed presigner, 3.1127.0, honours `signingDate`. It is deterministic within a window and rejects `expiresIn` above 604,800.
- **R2 honours the `response-*` overrides,** though its docs never mention them. On both buckets, through the S3 endpoint:
  - `response-cache-control` replaced the stored value, both `private, max-age=600` and `no-store`;
  - `response-content-type` was honoured;
  - `response-content-disposition` came back byte-for-byte as sent, Arabic RFC 5987 names included.

  Today's renamed-file download therefore works.

- **R2's S3 responses carry no framing headers:** no `X-Frame-Options`, no `Content-Security-Policy`, no `X-Content-Type-Options`, no `Cross-Origin-Resource-Policy`.
- **Stored cache headers:** public objects carry public ones (`lib/media/headers.ts`), images `max-age=31536000, immutable` and documents `max-age=3600`. Private objects are `no-store`.
- **Tests never reach the real presigner:** every test tier replaces it (`tests/helpers/preload-base.ts:94-96`). Child fixtures run under plain `bun --no-env-file`, without that preload.
- **Unpublish purges the public URL** through a deployment-wide budget of 900 calls per 300 s (`lib/cloudflare/purge.ts:42-43`).

**Contract and clients**

- Five handlers call `toMediaFile` directly: library upload, record upload (an array of one), details, publish and unpublish.
- `consistency.ts` does not infer status-set membership: a route missing from `CONFLICT_ROUTES` or `NOT_FOUND_ROUTES` passes.
- **The front end's media parsers** (`apps/front-end/lib/media/schemas.ts`) are plain `z.object`s, so new fields are dropped until they change.
- **Its cache patches** (`lib/media/cache.ts`) know nothing about counts.
- **The prototype loads private images only in details and quick look.**

## Preconditions

1. **Every response-contract phase in flight is committed.** Its later phases are being written in files this plan edits: `packages/shared/src/response-contract.ts`, and `components.ts`, `envelope.ts`, `route-operations.ts`, `route-tables.ts`, `consistency.ts` and `success-schemas.ts` under `lib/http/openapi/`.
2. **Before the front end switches routes,** its media work is committed by its owner. `components/dash/media/`, `lib/media/` and `mocks/handlers/media-library.ts` are untracked.

## Phase 0: probes (done)

| #   | Probe                                                                                                                | Result                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| a   | `ResponseCacheControl` returns that `cache-control`                                                                  | **passed** on both buckets, 2026-10-06                                |
| b   | `ResponseContentType: application/pdf` and an inline or attachment `ResponseContentDisposition` come back as sent    | **passed** on both buckets, Arabic names included                     |
| c   | No framing headers on S3-endpoint responses                                                                          | **passed**: none sent                                                 |
| d   | A 10-minute-window URL with `expiresIn` 4200 is accepted from its window start through 70 minutes, and refused after | **passed**: 200 at window start and 9 minutes back, 403 at 71 minutes |
| e   | The real presigner is deterministic within a window and changes with the next                                        | **passed** offline, matching reviewer B's run                         |

Each probe used one throwaway object per case under `probe/`, deleted afterwards. A listing confirmed both buckets empty.

**Cloudflare does not document this behaviour.** If it ever stops honouring the overrides, the failure is safe for private files:

- they keep their stored `no-store`;
- a preview downloads instead of displaying;
- a download keeps the name stored at upload.

## Locking protocol (every writer that touches files or folders)

| Path                                                                                   | Order                                                                                        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Every folder structure writer: create, rename, move, delete, the mixed move and delete | `lockTree` first                                                                             |
| Move core (`updateFolder`, mixed move)                                                 | tree → folders `FOR NO KEY UPDATE` (the moved ones and the destination) → files `FOR UPDATE` |
| Delete admission (file, folder, mixed)                                                 | tree → files `FOR UPDATE` → folders `FOR UPDATE`                                             |
| `updateFile`, `moveFiles`                                                              | files `FOR UPDATE` → `KEY SHARE` on the destination (foreign key)                            |
| Upload                                                                                 | insert → `KEY SHARE` on its folder (foreign key)                                             |
| Publish and unpublish                                                                  | one file `FOR UPDATE`                                                                        |

Rules:

- **Rows of one table are locked in `id` order.**
- **`NO KEY UPDATE` is enough for a move:** `lockTree` serialises every structural writer, and it stays compatible with the `KEY SHARE` of file moves and uploads.
- **The delete takes files before folders,** in `updateFile`'s order. Its folder `FOR UPDATE` then blocks new inserts until the folders are gone.

## Phase 1: error codes (request #1)

**Codes.** One `*_CODE` constant each in `packages/shared/src/error-codes.ts`, plus a `MEDIA_ERROR_CODES` tuple. Statuses do not change.

| Code                       | Messages                                                                                                            | Thrown at                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `FILE_NOT_FOUND`           | `fileNotFound` (404; 422 for a link or claim)                                                                       | `files.ts`, `lifecycle.ts`, `visibility.ts`, `link.ts`, the `files/[id]` handlers                  |
| `FOLDER_NOT_FOUND`         | `folderNotFound`                                                                                                    | `folders.ts`, `lifecycle.ts`, `constraint-errors.ts`, the `folders/[id]` handler, the upload route |
| `FILE_BUSY`                | `fileBusy`                                                                                                          | `files.ts`, `lifecycle.ts`, `visibility.ts`, `link.ts`                                             |
| `FILE_IN_USE`              | `fileInUse`, `fileInUseBy`                                                                                          | the delete admission                                                                               |
| `FOLDER_BUSY`              | `folderBusy`                                                                                                        | the delete admission                                                                               |
| `FOLDER_NAME_EXISTS`       | `folderNameExists`                                                                                                  | `folders.ts`, the move core                                                                        |
| `FOLDER_NOT_EMPTY`         | `folderNotEmpty`                                                                                                    | the delete admission                                                                               |
| `FOLDER_TOO_DEEP`          | `folderTooDeep`                                                                                                     | `folders.ts`, the move core                                                                        |
| `FOLDER_CYCLE`             | `folderCycle`                                                                                                       | the move core                                                                                      |
| `FOLDER_TOO_MANY_CHILDREN` | `folderTooManyChildren`                                                                                             | `folders.ts`, the move core                                                                        |
| `SELECTION_TOO_LARGE`      | `folderTooLarge`, plus a selection message                                                                          | the delete admission                                                                               |
| `VISIBILITY_DISABLED`      | `visibilityDisabled`                                                                                                | `visibility.ts`, `upload.ts`                                                                       |
| `UNPUBLISH_IN_USE`         | `unpublishInUse`                                                                                                    | `visibility.ts`                                                                                    |
| `LINK_NOT_ALLOWED`         | `linkNotAllowed`                                                                                                    | `link.ts`                                                                                          |
| `LINK_VISIBILITY_MISMATCH` | `linkVisibilityMismatch`                                                                                            | `link.ts`                                                                                          |
| `FILE_KIND_NOT_ALLOWED`    | `kindNotAllowedHere`                                                                                                | `upload.ts`, `link.ts`                                                                             |
| `FILE_TYPE_NOT_ALLOWED`    | `typeNotAllowed`, `invalidMimeType`                                                                                 | `upload.ts`, `image/process.ts`                                                                    |
| `FILE_TOO_LARGE`           | `fileTooLarge`, `documentTooLarge`                                                                                  | `upload.ts`                                                                                        |
| `FILE_CONTENT_REFUSED`     | `refused(…)`, `contentMismatch`, `animatedNotAllowed`, `undecodable`, the SVG content refusals, `svgOptimizeFailed` | `upload.ts`, `image/optimize.ts`, `image/process.ts`, `image/svg.ts`                               |
| `IMAGE_TOO_LARGE`          | `tooManyPixels`, `edgeTooLong`, `iccProfileTooLarge`, the SVG dimension refusals                                    | `image/optimize.ts`, `image/process.ts`                                                            |
| `IMAGE_NOT_COMPRESSIBLE`   | `targetUnreachable`                                                                                                 | `image/optimize.ts`                                                                                |

Not coded:

- the request-shape refusals (`noFiles`, `noValidFiles`, `maxFiles`, `unexpectedFormField`) and other input validation, as on every route;
- 5xx answers, `processingBusy` included.

**Implementation:**

- `lib/media/errors.ts` holds one factory per refusal: message, status, code and, where it applies, `data`. Every site uses one.
- `requireId` takes a refusal factory.
  - The 7 explicit callers pass theirs; the two-factor handler passes `notFoundError`.
  - The 9 default callers keep the default.
- `POST /api/dash/media/files` gets `handleFolderForeignKeyViolation`, so an upload racing a folder delete answers `FOLDER_NOT_FOUND`, not 500 (#15).
- `CustomError` gains an optional `data`. `ErrorBody.data` and `ApiErrorOptions` become `null | MediaRefusalData`, derived from a shared `mediaRefusalDataSchema`, `{ fileIds?, folderIds? }`.

**Ids.** Every refusal of a bulk route carries the ids that blocked it, however many items were sent:

- `FILE_IN_USE`, `FILE_BUSY` and the link refusals carry `fileIds`.
- `FOLDER_NOT_EMPTY`, `FOLDER_NAME_EXISTS`, `FOLDER_CYCLE`, `FOLDER_TOO_DEEP` and `FOLDER_BUSY` carry `folderIds`.
- **Never on a not-found:** a batch 404 does not say which id.
- Every id comes from the request or from the caller's visible library.

**Document:**

- `ErrorEnvelope` is unchanged. A new `MediaRefusalEnvelope`, with `data: MediaRefusalData`, is referenced only by the responses that can carry ids.
- A per-route media code table renders each route's 404, 409 and 422 descriptions, replacing the generic 409 text.

**Tests:**

- every refusal asserts its code;
- refusal bodies with and without `data` parse with the shared schema;
- `Retry-After` and the generic and auth failures are unchanged.

The runtime response check stays success-only. Checking error bodies at runtime is the response-contract plan's open owner choice.

## Phase 2: where used (request #3)

- **One enrichment path.**
  - `toMediaFiles(rows)` batches everything a file answer needs: `inUse`, and Phase 5's names.
  - `toMediaFile(row)` is `toMediaFiles([row])`, over one pure row formatter.
  - All five singular producers and the record upload's array go through it. Details reuses its own usage read for `inUse`.
- **`inUse: boolean` on `mediaFileSchema`.** `usedIds(fileIds)` runs one `EXISTS` per registered source and loads no referrer rows. The delete refusal's ids and the preview use it too.
- **A bounded usage list.**
  - `usedBy` holds at most `MEDIA_USAGE_LIST_MAX` (20) visible usages.
  - The new `visibleUsages` gives their total, and `hiddenUsages` stays.
  - The counts are SQL aggregates. The refusal message's labels come from a `distinct` query (#19).
- **Record names:** `mediaUsageSchema.name: string | null`.
  - A registry entry may supply `recordName`: an SQL expression, written in code, over an aliased owner row (for example `translations->'ar'->>'title'`).
  - It may also supply `ownerTable`, joined on `owner.id = source.<idColumn>`. The join is skipped when the owner is the source table itself.
  - Names appear only for usages the caller may view.
- **Tests:**
  - many referrers for one file, and several sources;
  - hidden usages;
  - a name from the source table itself, from a joined owner table, and from a jsonb expression.

## Phase 3: folder figures and the delete (request #5)

1. **Counts on every folder answer:** `subfolderCount` and `fileCount`, direct only, counting active files. They are correlated `count(*)` subqueries in `listSubfolders` and `searchFolders`.
   - `fileCount` reads heap rows, because no `folder_id` index includes `status`.
   - Add a partial index on `(folder_id) WHERE status = 'active'` only if a measured listing is slow.
2. **`GET /api/dash/media/folders/:id`** (`media.view`, 120 per minute): the folder, its breadcrumbs, and `totals: { folders, files, bytes }` for its subtree, as one aggregate statement.
3. **`GET /api/dash/media/stats`** (`media.view`, 60 per minute): the same totals over the files the library governs (`mediaGoverned()`, exported).
4. **Abandoned uploads.**
   - One constant, `ABANDONED_AFTER = '10 minutes'`, moves out of `visibility.ts` (`TRANSITION_STALE_AFTER`) so the transition sweep and the delete share it. Its comment keeps the bound: R2's worst case, 3 × (3 s + 15 s), must stay well inside it.
   - A `pending` row in a folder whose `created_at` is older than this is abandoned. Library uploads insert and activate within one request (`storeUpload`), so it cannot still be running. The sweep's 24-hour expiry also measures `created_at`.
   - **Invariant: a `deleting` row holds no folder.** Every path that marks a row `deleting` also sets `folder_id = null`: the delete admission, and the sweep's expiry of `pending` rows (`sweepFiles`). An upload that the sweep could not finish then never blocks or strands a folder.
5. **The delete admission: one transaction.** It replaces `deleteFiles`' marking phase, `deleteFolderTree` and `deleteFolder`.
   - **Body:** a shared `mediaDeleteSelectionSchema`, `{ fileIds?, folderIds?, recursive? }`, strict, with 1–50 ids.
   - **Normalisation:** a selected item with a selected ancestor is dropped, through one helper shared with the move.
   - **Under `lockTree`:**
     1. **Walk:** the selected folders and at most cap + 1 of their descendants, then at most cap + 1 files. PostgreSQL stops a recursive CTE early only while the outer query neither sorts nor joins it.
     2. **Scope** (`deleteOwn`): any folder or file outside the caller's scope answers 404, as if absent. Checked first.
     3. **Cap:** everything deleted besides the selected folders themselves, at most 200, selected files included → `SELECTION_TOO_LARGE`.
     4. **Without `recursive`,** a selected folder holding anything other than abandoned uploads → `FOLDER_NOT_EMPTY` with its id. If only fresh uploads block it → `FOLDER_BUSY` with its id.
     5. **Lock:** files `FOR UPDATE`, then folders `FOR UPDATE`, each in `id` order. Membership is re-read once the locks are held.
     6. **Busy:**
        - a file mid-transition → `FILE_BUSY` with ids;
        - a fresh `pending` row → `FOLDER_BUSY` with folder ids;
        - abandoned `pending` rows join the deletion.
     7. **Write:**
        - mark the files `deleting` and detach them (`folder_id = null`);
        - detach any row already `deleting` that still holds a folder in the tree, in the same statement (left from before this change);
        - delete the folder rows;
        - audit each row with its original folder.

        A referenced file fails the composite foreign key, the transaction rolls back, and the answer is `FILE_IN_USE` with `fileIds`.
   - **After commit,** `finishDeleting` runs outside the transaction, as `db/limits.ts` requires.
     - It removes each key from every enabled bucket, an abandoned upload's partial object included.
     - Whatever R2 or the purge refuses stays `deleting` for the sweep. It is already detached, so no folder waits for it.
   - **Result:** the database change is all-or-nothing.
     - It closes #2 (the moved-out file), #6 (stranded folders), #17 (the unbounded read) and #18 (the 24-hour block).
     - `folders: 0` no longer happens.
   - **Answer:** `deletedFolderSchema` plus `folderIds`, every deleted folder id including descendants.
   - **Routes:** `DELETE /api/dash/media` (new); `DELETE /api/dash/media/folders/:id`, where `?recursive` maps to `recursive`; and `DELETE /api/dash/media/files`, until it is retired.
6. **`POST /api/dash/media/delete-preview`** (`media.delete` with the caller's scope, 60 per minute).
   - Body: the delete's own body.
   - It runs steps 1–4 and 6 as data, not errors, in a read-only, repeatable-read transaction, with no `lockTree` and no row locks.
   - Answer: `{ folders, files, limit, exceedsLimit, nonEmptyFolderIds, busyFileIds, inUseFileIds, unfinishedFolderIds }`. The lists are `null` when `exceedsLimit` (not computed) and `[]` when empty.
   - Scope failures answer 404, as the delete does.
   - It is advisory.
7. **Tests:**
   - counts, totals and stats;
   - the preview and the delete agree, per recursion mode and per blocker;
   - the 200/201 boundary, overlaps included;
   - a fresh `pending` row blocks, while an abandoned one is deleted together with its object;
   - a row the sweep expired, whose object R2 then refused, neither blocks nor strands its folder;
   - with real transactions: a file moved out before admission survives, a subfolder moved out keeps its files, and an upload racing the admission;
   - an R2 failure leaves no folder behind.

## Phase 4: stable private URLs (request #2)

- **The window lives at the media boundary.** A media signing helper computes `{ signingDate, expiresIn }` from epoch milliseconds: a 10-minute window, and `expiresIn` = 10 + 60 minutes.
  - `getPresignedUrl` gains `signingDate` and keeps its clamp and seven-day semantics.
  - A link stays the same for 10 minutes and is valid for 60–70 minutes; probe (d) confirmed this live.
  - This is a published technique: [Cacheable S3 signed URLs](https://advancedweb.hu/cacheable-s3-signed-urls/) and [Stable S3 signed URLs](https://advancedweb.hu/stable-s3-signed-urls/). The one change from it: the window is added to the lifetime, so a link never lasts less than an hour.
- **Cache override:** `private, max-age=600`, only when `kind === 'image'` and `bucketType === 'private'`. Documents get none. Probe (a) confirmed it works.
- **`downloadUrl` and `previewUrl`:** `ResponseCacheControl: 'no-store'` for both buckets, because public objects carry public cache headers.
- **Tests:**
  - a real-presigner child-process test (`tests/fixtures/_presign-child.ts`, no preload) for determinism, the next window, and a request near the seven-day ceiling;
  - the stub records `signingDate` and every `Response*` override;
  - the clock is pinned wherever two requests are compared.

## Phase 5: uploader name (request #6)

- **New fields:** `uploadedByName: string | null` on files and `createdByName: string | null` on folders.
- **One batched `userNames(ids)`** in `lib/users/names.ts`, over `liveUser` rows (`lib/users/filters.ts:8`). It returns `null` for a soft-deleted user; a deactivated user keeps their name.
- **Producers:**
  - files: the Phase 2 enrichment path;
  - folders: `listSubfolders`, `searchFolders` and folder details.
- **Tests:** a name is returned; it becomes `null` after a soft delete.

## Phase 6: mixed move and limits (request #4)

1. **`PUT /api/dash/media`** moves a selection.
   - **Body:** `{ fileIds?, folderIds?, to: id | null }`, strict, with 1–50 ids. `to: null` with files is refused, with a new message.
   - **Normalisation** is the same as the delete's. The move then follows the locking protocol.
   - **Checks:**
     - **cycle:** walk up from `to`, at most `FOLDER_MAX_DEPTH` + 1 rows. If `to` or one of its ancestors is selected → `FOLDER_CYCLE` with `folderIds`.
     - **depth:** one `max(level)` aggregate over every moved subtree, capped at the allowed height + 1 → `FOLDER_TOO_DEEP` with `folderIds`.
     - **fan-out:** the destination's children plus the incoming folders → `FOLDER_TOO_MANY_CHILDREN`.
     - **names:** one SQL statement over the destination's children plus the moved folders, comparing `lower(name)` as the unique indexes do. A clash → `FOLDER_NAME_EXISTS` with `folderIds`. The index stays the backstop.
   - **Answer:** `{ fileIds, folderIds, unfiledAt: null, updatedAt }`, the ids actually re-parented.
   - **Shared core:** `updateFolder`'s move uses the same core, which removes its unbounded subtree read (#16).
2. **Limits.**
   - Publish, scope `media.files.publish`: 60 per minute.
   - Unpublish, scope `media.files.unpublish`: stays at 10 per minute. Each unpublish spends purge calls from the deployment-wide budget of 900 per 5 minutes, which 60 per minute would let two or three users exhaust.
   - There is no bulk endpoint.
3. **Expand, then contract.**
   - The old `PUT` and `DELETE /api/dash/media/files` stay, running the new cores, until the front end has switched.
   - A later release removes them, with their `REQUEST_BODIES` and `RESPONSE_DATA` keys and their consumers: `lib/media/actions.ts`, `mocks/handlers/media-library.ts`, and the git-ignored `tests/mocks-media-library.test.ts`.
4. **Registration:**
   - add the `routes.ts` rows and the `REQUEST_BODIES`, `RESPONSE_DATA` and `OPERATION_DOCS` entries, and the status sets;
   - `consistency.ts` does not catch a missing status-set entry, so `tests/unit/openapi-contract.test.ts` gains per-route assertions that every refusal status a new route answers is published.
5. **Tests:**
   - cycle, depth, fan-out and name clashes, at the destination and within the selection, each with its ids;
   - nested selections normalised; own scope; no-ops;
   - with real transactions: the mixed move against `PUT /files/:id` (the deadlock schedule) and against an upload;
   - both limits.

## Phase 7: PDF preview (request #7)

- **New field:** `previewUrl: string | null` on file details, set only for `application/pdf`. It is signed on the S3 endpoint for either bucket, never `getPublicUrl`, with:
  - an inline `ResponseContentDisposition`;
  - `ResponseContentType: 'application/pdf'`;
  - `ResponseCacheControl: 'no-store'`.

  Probes (b) and (c) confirmed the headers, and that no framing header blocks an iframe.

- **Security:**
  - **Stored objects keep `attachment`.** The comment in `objectHeaders` is extended to name the preview as the one inline path and why it lives on the S3 origin.
  - **The S3 origin is a separate site** with no cookies or session.
  - **R2 sends no `X-Content-Type-Options`,** but a declared `application/pdf` is not a type browsers sniff: the MIME Sniffing Standard sniffs missing and generic types. A polyglot is therefore shown by the PDF viewer.
  - **PDF JavaScript is not stripped** (`lib/media/allowlist.ts:30,49`). The accepted residual risk is phishing content inside the viewer.
- **Front end:**
  - `frame-src` needs only the S3 origin; `img-src` needs the public domain and the S3 origin.
  - The iframe must not carry `sandbox`: Chromium's viewer needs what a sandbox forbids. This is the reviewer's source; not re-checked here.

## Contract changes

| Change                                                                                                                                                 | Kind                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `code` on media refusals, upload families included; `MediaRefusalEnvelope` with `data: { fileIds?, folderIds? }` on bulk refusals                      | additive                               |
| `MediaFile`: `inUse`, `uploadedByName`                                                                                                                 | additive                               |
| `MediaFolder` (listing and search hits): `subfolderCount`, `fileCount`, `createdByName`                                                                | additive                               |
| `MediaFileDetails`: `previewUrl`, `visibleUsages`; `usedBy` capped at 20                                                                               | additive and behaviour                 |
| `MediaUsage.name`                                                                                                                                      | additive                               |
| Folder delete answers: `folderIds`                                                                                                                     | additive                               |
| `GET /api/dash/media/folders/:id`, `GET /api/dash/media/stats`, `POST /api/dash/media/delete-preview`, `PUT /api/dash/media`, `DELETE /api/dash/media` | new                                    |
| `PUT` and `DELETE /api/dash/media/files`                                                                                                               | deprecated, removed in a later release |
| Signed links stable for 10 minutes and valid 60–70 minutes; private images cacheable for 10 minutes; download and preview `no-store`                   | behaviour                              |
| An upload abandoned for 10 minutes is deleted with its folder                                                                                          | behaviour                              |
| Publish 60 per minute, unpublish 10                                                                                                                    | behaviour                              |

## Front-end handoff (for its own agent)

- **Parsers.** `lib/media/schemas.ts` drops every new field until it adds them, or until response-contract Phase 2 binds the shared schemas. That is a dependency of every phase that adds a field.
- **Cache.**
  - Patch counts after an upload, move, delete or create (`lib/media/cache.ts`), and give a locally built folder (`lib/media/actions.ts`) the new fields.
  - Refresh folder details and stats after a write, or patch only what an answer proves.
  - Patch moves and deletes from the returned ids, never from the selection.
- **Errors:** `failure()` keeps `data`, and the screen branches on codes.
- **Mocks:** codes, ids, the new fields and the new routes.
- **Copy:** the null-name label goes in `constants/messages.ts`.
- **Routes:** switch to the mixed routes, so that the old ones can be retired.
- **CSP and iframe:** the hosts and the `sandbox` note from Phase 7.
- **Checks:** run lint and `bun test tests` in `apps/front-end` whenever a shared schema changes.

## Docs and copy

- **`docs/file-manager-user-guide.md`:**
  - §3: counts and storage;
  - §5 and §8: mixed moves and nested selections;
  - §6 and §12: the split limits;
  - §7: the one-transaction delete, removing the "folders remain" case and adding the 10-minute rule for abandoned uploads;
  - §10: link lifetimes and caching;
  - §13: the codes;
  - §14: remove "no document preview";
  - §15: points 6, 8, 15 and 16.
- **`success-schemas.ts` descriptions:** the lifetimes of `url` and `downloadUrl`, and `folders`/`folderIds` on the delete answers.
- **`OPERATION_DOCS`:** every route change.
- **`messages/validation.ts` and `messages/media.ts`:** selection-wide "at least one item" and "at most N items" messages (the file-only ones stay for the old routes), "files cannot be moved to the root", and "the selection is too large".
- **`reports/review-findings.md`:** remove #2, #6 and #15–#19 as their phases land.
- **Server:** no server-side step, so `reports/coolify-deployment.md` stays untouched.

## Not doing

- **Dropped by the owner:** duplicate warning, ZIP download, replacing a file's content.
- **A bulk publish endpoint.**
- **An in-use flag on folders.**
- **Recursive size in listings.**
- **Avatars.**
- **Caching download or preview links.**
- **A back-end environment variable for the front end's CSP.**
- **Deleting an upload younger than 10 minutes.**
- **The `active`-only partial index,** until it is measured.
- **A runtime check of error bodies:** an open owner choice in the response-contract plan.

## Verification (each phase)

- **Lint:** `bun run lint` in `packages/shared` and `apps/back-end`, and in `apps/front-end` with `bun test tests` whenever a shared schema changes.
- **Tests:** `bun run test`, `bun run test:integration` and `bun run test:matrix` through the runner.
- **Lock tests** use real transactions with explicit synchronisation and short holds, of 200 ms or less. Long real waits have stalled full parallel runs before.
  - Each deadlock schedule is first probed on a throwaway database with two connections.
  - A spy does not prove lock compatibility.
- **Document diff** over the touched routes and components.
- **Deliberate-break probes,** each reverted once it fails as expected:
  - a factory without its code;
  - a cap off by one;
  - a preview without its scope check;
  - folder locks back to `FOR UPDATE` in the move core;
  - a missing status-set entry;
  - the abandoned-upload threshold dropped to zero.
- **Report every check not run.**

## Risks

- **Concurrency is the hard part.** The locking protocol, real-transaction tests and the deadlock probes carry it.
- **R2's response overrides are undocumented.** They were verified live on 2026-10-06 and fail safe for private files (Phase 0).
- **Usage features stay dormant** until a project registers a source. The tests cover them through the fixture.
- **Two plans edit the same files** (Preconditions).

## Review log (2026-10-06)

Codex (`C`) and Claude (`L`) reviews. Every finding was verified against the code; `L1` and `L13` were confirmed by probes, and `C12` and `L13` were reproduced offline here.

| Finding                                               | Outcome                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| C1 stale plan deletes a moved-out file                | Adopted: one-transaction admission (Phase 3). Existing defect, `review-findings.md` #2 |
| C2 "all-or-nothing" vs `folders: 0`                   | Adopted differently: detaching makes the database change atomic with no migration (#6) |
| C3, L1 lock-order deadlock                            | Adopted: locking protocol, `NO KEY UPDATE` in moves, `id`-ordered locks                |
| C4 public objects cache download and preview          | Adopted: explicit `no-store`, live-verified                                            |
| C5 preview contract                                   | Adopted: same body, analysis as data, `null` lists above the cap                       |
| C6 singular producers                                 | Adopted: one enrichment path                                                           |
| C7 `ErrorBody.data` typed `null`                      | Adopted                                                                                |
| C8, L15 `requireId` callers                           | Adopted: 7 explicit callers, the two-factor handler included                           |
| C9 unbounded usage rows                               | Adopted: `EXISTS`, aggregates, a capped list (#19)                                     |
| C10, L5 unbounded move subtree                        | Adopted: ancestry walk, aggregate height (#16)                                         |
| C11 front-end parsers and cache                       | Adopted: handoff section                                                               |
| C12 seven-day ceiling                                 | Adopted: window at the media boundary                                                  |
| C13 consistency gate scope                            | Adopted: per-route status assertions                                                   |
| L2 purge budget                                       | Adopted: publish 60, unpublish 10                                                      |
| L3 empty-delete 200                                   | Resolved by the one-transaction admission                                              |
| L4 cache on documents, little benefit                 | Adopted: images only, 10-minute window                                                 |
| L6 nested selections, internal name clashes           | Adopted: shared normalisation, SQL name check                                          |
| L7 which folders were deleted                         | Adopted: `folderIds`; all-or-nothing now holds                                         |
| L8 ids on every bulk refusal; upload codes            | Adopted: family codes, ids regardless of count                                         |
| L9 shared envelope widened                            | Adopted: `MediaRefusalEnvelope`, per-route code table                                  |
| L10 same-release removal                              | Adopted: expand, then contract. Narrowed: separate deploys not verified                |
| L11 preview before its delete; stale precondition     | Adopted: the delete moved into Phase 3; precondition reworded                          |
| L12 bounded walk, check order, preview without locks  | Adopted                                                                                |
| L13 real presigner untested; hour-turn flake          | Adopted; Phase 0 then run live                                                         |
| L14 upload FK answers 500                             | Adopted (#15)                                                                          |
| L16 `recordName` cannot reach jsonb; self-join        | Adopted: an expression over an aliased owner                                           |
| L17 stale copy and descriptions                       | Adopted: Docs and copy                                                                 |
| L18 counts read heap rows; pending rows block deletes | Adopted: measured index only; abandoned uploads (10 minutes) join the delete (#18)     |
