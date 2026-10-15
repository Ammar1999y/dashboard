# Media library: back-end requests for the new file manager

The dashboard's media library is being rebuilt as a Finder-style file manager: column view, a grid and list, cut & paste moving, multi-select bulk actions, and a details inspector. A clickable prototype that runs against a mock of the current API is at `design-prototypes/file-manager/b-studio.html`. Features it marks ✦ are the ones listed below.

This is a list of proposals, not a spec. For each item, decide whether it fits the back end's design, security model and standards. You can implement it, implement it differently, defer it, or decline it. Where you decline or change something, explain why in your reply so the front end can adapt. The field and endpoint names below are suggestions only.

The current behaviour each item refers to is documented in `apps/back-end/docs/file-manager-user-guide.md` and the code paths cited.

---

## Priority 1

### 1. Machine-readable error codes on media errors

**Today:**
- `CustomError` takes `(message, status, code?)` (`packages/shared/src/error-class.ts`), and `lib/http/response.ts` already forwards `code`.
- None of the media throws in `lib/media/*` and `app/api/dash/media/**` pass one.
- So a single status covers unrelated cases:
  - **409:** folder name exists · file busy · file in use · folder not empty · unpublish blocked.
  - **422:** too deep · cycle · too many children · folder too large · visibility disabled.

**Why the front end needs it:** the UI reacts differently to each case:
- name clash: an inline field error;
- not empty: offer recursive delete;
- busy: retry automatically;
- in use: show the usages.

Today the only option is comparing Arabic text, which breaks on any wording change and is impossible for messages that contain names, such as `fileInUseBy`.

**Proposal:** a stable code on every media refusal. Ideally the codes are exported constants in `@app/shared` so both apps import the same values.

### 2. Stable private URLs, cacheable for their lifetime

**Today:**
- Private `url`s are presigned on every listing (performance audit C-6), so the string changes on every response.
- Objects are stored with `private, no-cache, no-store, must-revalidate` (`lib/media/headers.ts`).
- The browser re-downloads every private image each time a view mounts, even when React Query has the list cached.

**Proposal:**
- **Deterministic presigning.** Sign with a time-bucketed `signingDate`, e.g. the start of the current hour, with an expiry that always leaves at least about an hour, e.g. bucket start + 2 h. Everyone then gets an identical URL within the bucket, with nothing stored.
  - The installed `@aws-sdk/s3-request-presigner` (3.1127.0) accepts `signingDate` through `@smithy/types`.
- **Let the browser keep private objects for that window:** `private, max-age=3600`.
  - For objects already uploaded, a `ResponseCacheControl` override on the presigned GET may avoid rewriting them. **Not verified** that R2 honours `response-cache-control`; please check.
  - This is a security trade-off: a private file stays in that browser's cache for up to an hour, which matters on a shared computer. Your call whether it is acceptable.

### 3. "Where used": a flag in listings, names in details

**Today:**
- `usedBy` returns `{ label, resource, recordId }` and only on `GET /files/:id`.
- Bulk delete is all-or-nothing, so one used file among 50 fails the whole batch.
- No table references `files` yet (`USAGE_SOURCES = []`), so none of this fires today. It matters as soon as records such as projects or sections get file fields.

**Proposal:**
- **In list responses:** a per-file `inUse` boolean or usage count. The grid marks used files, and bulk delete can leave them out before sending.
- **In `usedBy`:** the owning record's display name, e.g. "صورة مشروع — الواجهة البحرية", instead of only the label and id.

---

## Priority 2

### 4. Bulk operations on folders, and bulk publish

**Today:**
- Bulk move and delete accept file ids only, 1–50 per request.
- Folders are moved or deleted one per request.
- Publish/unpublish is single-file only, at 10/min shared between the two.
- A mixed selection therefore becomes many requests and cannot be all-or-nothing.

**Proposal:**
- Bulk move and bulk delete that accept folder ids as well, mixed with files, with whatever caps keep them safe.
- Bulk publish/unpublish, with a rate limit that makes publishing a few dozen files practical.

### 5. Folder figures and a delete preview

**Today:** there are no per-folder counts or sizes, and no storage total. A recursive delete learns that a folder exceeds the 200-descendant cap only when it is attempted.

**Proposal:**
- Per-folder item count in the listing (direct children at least; a recursive size if affordable).
- A library storage-used total.
- A way to preview a recursive delete before confirming: descendant folder and file counts, whether the cap is exceeded, and whether any file is busy or in use. It could be a summary endpoint or a dry-run flag. The confirm dialog can then say "4 folders and 37 files" and refuse up front.

### 6. Uploader name

**Today:** `uploadedBy` and `createdBy` are user ids only.

**Proposal:** return the user's display name with the file and folder, plus an avatar if one exists.

### 7. PDF preview link

**Today:** documents are always served as attachments (`lib/media/headers.ts`), so a PDF can only be downloaded.

**Proposal:** in file details, a separate `previewUrl` for PDFs that opens inline:
- presigned with an inline `ResponseContentDisposition` and the right `ResponseContentType`;
- the existing `downloadUrl` stays as it is;
- the front end shows it in an iframe using the browser's built-in viewer.

No thumbnails are wanted for documents. Please judge the security side of serving PDFs inline from the storage origin.

---

## Priority 3

### 8. Duplicate warning on upload

**Today:** `files.sha256` is stored but unused.

**Proposal:** a non-blocking hint in the upload response, e.g. `duplicates: [{ id, displayName, folder }]` when the stored bytes match an existing active file, so the UI can offer to keep or remove the new copy.

The hash is taken over the *stored* (re-encoded) bytes, so this catches identical uploads only. Note whether re-encoding the same input is deterministic.

### 9. ZIP download of several files

**Proposal:** download a selection, and optionally a folder, as one streamed ZIP, with caps on file count and total size.

### 10. Replace a file's content

**Today:** listed as intentionally absent in the user guide; the owner would like it reconsidered.

**Proposal:** upload new content for an existing file id, so references keep pointing at the same id. Public images are cached `immutable` for a year, so the replacement must get a new object key or URL, and the old object must be purged.

---

## Out of scope: please don't build these

Trash/restore, favourites, recent files, tags / alt text / captions, expiring share links, image thumbnails or variants, document thumbnails, chunked or resumable uploads, realtime updates, files at the library root, a one-call folder tree, search through subfolders, and copy/duplicate.

## What to send back

For each numbered item:
- **Status:** done, planned, done differently (how), or declined (why).
- **The exact contract:** request and response fields, error codes, limits.
- **Breaking changes:** any change to an existing response.
