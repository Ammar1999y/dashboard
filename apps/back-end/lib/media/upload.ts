import { createHash } from 'node:crypto';
import type { AuditActor } from './actor';
import type { FileTypeSpec } from './allowlist';
import type { DetectResult } from './detect-result';
import type { MediaFileRow } from './files';
import type { ValidatedSvgUpload } from './image/process';
import type { HandlerInput } from '@/lib/http/contract';
import type { ObjectHead } from '@/lib/r2/client';
import type { EntityID } from '@app/shared/types';
import type { BucketType, FileKind } from '@app/shared/validation/enums';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  MIB,
} from '@app/shared/validation/constants';
import { normalizeMimeType } from '@app/shared/validation/media-types';

import { MAX_REQUEST_BODY_BYTES } from '@/lib/http/request';
import { generateUuidV7 } from '@/lib/id';
import {
  headObjectInR2,
  isPreconditionFailedError,
  uploadToR2,
} from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { errorTypeOf, logSanitized } from '@/utils/log';

import { auditAs } from './actor';
import { fileTypeFor } from './allowlist';
import { sanitizeFilename } from './filename';
import { FILE_COLUMNS, matchesRow } from './files';
import { objectHeaders } from './headers';
import { measureEncodeCost } from './image/optimize';
import {
  processImage,
  validateMagicBytes,
  validateSvgUpload,
} from './image/process';
import { objectKey } from './keys';
import { mediaMsg, uploadMsg } from './messages';

/**
 * Requests admitted per user per minute BEFORE the body is read, on both upload
 * routes. The kind-specific budgets below can only be charged once the bytes
 * say which kind this is, so this bounds what an account can make the server
 * parse while over one of them.
 */
export const UPLOAD_ADMISSION_LIMIT = 20;

/**
 * One limiter bucket for both upload routes, so the allowance above is per USER
 * and not per user per route, like the kind budgets below.
 */
export const UPLOAD_ADMISSION_SCOPE = 'upload.admission';

/**
 * The per-user IMAGE budget, in MEGAPIXELS of decode work rather than requests:
 * the encoder is process-global and serialized, so a request count lets one
 * account hold it for most of every window with maximum-size images. Sized so
 * the worst case the constants admit fits a few per window.
 */
export const UPLOAD_MEGAPIXEL_BUDGET = 100;

/**
 * The floor charge for ONE image request, whatever its pixels. A request's cost
 * is `max(unit, megapixels)`, most uploads are far under a megapixel, and every
 * one still costs a parse, a decode, a PUT and two writes (an SVG costs jsdom
 * and svgo and never reaches `measureEncodeCost`), so `BUDGET / UNIT` is the
 * request ceiling — the number to move when that is what is meant.
 *
 * Exported with the budget so `tests/unit/upload-validation.test.ts` can state
 * both derived ceilings against the real values rather than against a copy.
 */
export const UPLOAD_REQUEST_UNIT = 5;

/**
 * The DOCUMENT budget, in mebibytes per minute per user. A document is not
 * decoded — its cost is the multipart parse, one container inspection and one
 * PUT — so bytes are the honest unit. `max(unit, MiB)`, like the image side.
 *
 * Exported with its unit so `tests/unit/upload-validation.test.ts` can state the
 * derived request ceiling against the real values rather than against a copy.
 */
export const DOCUMENT_BYTE_BUDGET_MIB = 60;
export const DOCUMENT_REQUEST_UNIT = 2;

function documentCost(sizeBytes: number): number {
  return Math.max(DOCUMENT_REQUEST_UNIT, Math.ceil(sizeBytes / MIB));
}

const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE * MIB;
const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_SIZE_MB * MIB;

/**
 * Mebibytes of multipart body per minute per user that this deployment will
 * BUFFER, charged from `Content-Length` before the parser touches the stream.
 *
 * The kind budgets charge only the ADMITTED file, once it is in memory; a body
 * that is refused was still parsed in full. Without this the real per-user
 * buffering ceiling is `UPLOAD_ADMISSION_LIMIT` × `MAX_REQUEST_BODY_BYTES`.
 *
 * Twice the largest kind budget, so it cannot bind before one of them does.
 */
const UPLOAD_BODY_BUDGET_MIB = 2 * DOCUMENT_BYTE_BUDGET_MIB;

/**
 * Every budget above, against the cost of the largest request its own ceiling
 * admits.
 *
 * A single legal maximum-size request must still fit in one window, or the size
 * ceiling admits a request the limiter can never charge — and `rateLimit`
 * refuses `cost > limit` WITHOUT a write, so it is a permanent 429 rather than a
 * slow path. Checked at load: each budget lives here and each ceiling in
 * another file, and nothing else connects the pairs.
 */
const BUDGET_CEILINGS = [
  {
    budgetName: 'UPLOAD_MEGAPIXEL_BUDGET',
    budget: UPLOAD_MEGAPIXEL_BUDGET,
    maximumCost: Math.max(
      UPLOAD_REQUEST_UNIT,
      Math.ceil(MAX_IMAGE_PIXELS / 1_000_000)
    ),
  },
  {
    budgetName: 'DOCUMENT_BYTE_BUDGET_MIB',
    budget: DOCUMENT_BYTE_BUDGET_MIB,
    maximumCost: documentCost(MAX_DOCUMENT_BYTES),
  },
  {
    budgetName: 'UPLOAD_BODY_BUDGET_MIB',
    budget: UPLOAD_BODY_BUDGET_MIB,
    maximumCost: Math.ceil(MAX_REQUEST_BODY_BYTES / MIB),
  },
];

const unaffordable = BUDGET_CEILINGS.find(
  (ceiling) => ceiling.maximumCost > ceiling.budget
);
if (unaffordable)
  throw new Error(
    `${unaffordable.budgetName} (${unaffordable.budget}) is below the cost of one ` +
      `maximum-size upload (${unaffordable.maximumCost}); every such upload ` +
      'would answer 429 forever.'
  );

/**
 * Charged BEFORE `readFormData()`, from the only size a request states ahead of
 * its body.
 *
 * A body with no `Content-Length` (chunked) is charged the server-wide ceiling:
 * that is what the parser may go on to buffer, and a caller who omits the
 * header must not thereby pay less than one who states it.
 */
async function chargeUploadBodyBudget(
  userId: EntityID,
  headers: Headers
): Promise<void> {
  const declared = Number(headers.get('content-length'));
  const bytes =
    Number.isSafeInteger(declared) && declared > 0
      ? Math.min(declared, MAX_REQUEST_BODY_BYTES)
      : MAX_REQUEST_BODY_BYTES;
  await enforceRateLimit({
    scope: 'upload.body',
    identifier: userIdentifier(userId),
    limit: UPLOAD_BODY_BUDGET_MIB,
    cost: Math.ceil(bytes / MIB),
    failClosed: true,
  });
}

/** Where an upload goes and what it may be, decided by the route — never by the client. */
interface UploadTarget {
  visibility: BucketType;
  kinds: readonly FileKind[];
  /** Library uploads live in a folder; entity uploads have none until claimed. */
  folderId: EntityID | null;
  /** Library uploads become listable at once; entity uploads wait for `claimFiles`. */
  activate: boolean;
}

/** One file past every byte-level check, with its bytes in hand. */
interface AdmittedUpload {
  file: File;
  buffer: Buffer;
  /**
   * `file.type` with its parameters stripped and lowercased — the ONE string
   * every downstream check must compare against, or a parameterised type
   * resolves to its spec and then skips the byte-level checks keyed on the
   * bare type.
   */
  mimeType: string;
  spec: FileTypeSpec;
  validatedSvg?: ValidatedSvgUpload;
}

const MAX_FILES_PER_REQUEST = 1;

/**
 * The one file of a single-file upload form. `formData` is `null` when the
 * body was not multipart at all.
 *
 * ⚠️ EXACTLY one part, and nothing beside it. Both upload routes take every
 * other input from the query string, and `request.formData()` has already
 * BUFFERED every part it was sent, so an extra part would ride along unpriced
 * beside a small admitted file.
 */
function takeSingleFile(formData: FormData | null, field: string): File {
  if (!formData)
    throw new CustomError(uploadMsg.noFiles, HTTP_STATUS.BAD_REQUEST);
  for (const [name] of formData)
    if (name !== field)
      throw new CustomError(
        uploadMsg.unexpectedFormField(sanitizeFilename(name)),
        HTTP_STATUS.BAD_REQUEST
      );
  const entries = formData.getAll(field);
  if (entries.length === 0)
    throw new CustomError(uploadMsg.noFiles, HTTP_STATUS.BAD_REQUEST);
  if (entries.length > MAX_FILES_PER_REQUEST)
    throw new CustomError(
      uploadMsg.maxFiles(MAX_FILES_PER_REQUEST),
      HTTP_STATUS.BAD_REQUEST
    );
  const [entry] = entries;
  if (!(entry instanceof File))
    throw new CustomError(uploadMsg.noValidFiles, HTTP_STATUS.BAD_REQUEST);
  return entry;
}

/** The size ceiling per kind, checked from the declared size before any read. */
function maxBytesFor(kind: FileKind): number {
  return kind === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
}

/**
 * The allowlist's contract is that a `detect` ANSWERS — its input is hostile
 * bytes, so a throw is one entry's bug and not a 500 for both upload routes.
 * The bytes are refused and the entry named, because a detector that throws is
 * a defect someone has to see.
 */
function inspect(spec: FileTypeSpec, bytes: Buffer): DetectResult {
  try {
    return spec.detect(bytes);
  } catch (error) {
    logSanitized('error', {
      msg: 'media.detect threw',
      extension: spec.extension,
      errorClass: errorTypeOf(error),
    });
    return { ok: false, reason: 'container' };
  }
}

/**
 * Everything that can be decided before the bytes are read, then the bytes,
 * then everything the bytes decide. Refusals name the file by its sanitised
 * name only.
 */
export async function admitUpload(
  entry: File,
  target: Pick<UploadTarget, 'kinds'>
): Promise<AdmittedUpload> {
  const safeName = sanitizeFilename(entry.name);

  const mimeType = normalizeMimeType(entry.type);
  const spec = fileTypeFor(mimeType);
  if (!spec)
    throw new CustomError(
      mediaMsg.typeNotAllowed(safeName),
      HTTP_STATUS.BAD_REQUEST
    );
  if (!target.kinds.includes(spec.kind))
    throw new CustomError(mediaMsg.kindNotAllowedHere, HTTP_STATUS.BAD_REQUEST);

  if (entry.size > maxBytesFor(spec.kind))
    throw new CustomError(
      spec.kind === 'image'
        ? uploadMsg.fileTooLarge(safeName, MAX_IMAGE_SIZE)
        : mediaMsg.documentTooLarge(safeName, MAX_DOCUMENT_SIZE_MB),
      HTTP_STATUS.BAD_REQUEST
    );

  const buffer = Buffer.from(await entry.arrayBuffer());

  const detected = inspect(spec, buffer);
  if (!detected.ok)
    throw new CustomError(
      mediaMsg.refused(safeName, detected.reason),
      HTTP_STATUS.BAD_REQUEST
    );

  if (spec.kind !== 'image') return { file: entry, buffer, mimeType, spec };

  // The image pipeline's own byte checks: animation is a refusal the signature
  // check above cannot see, and the SVG sanitiser is the SVG's only check.
  const magic = validateMagicBytes(buffer, mimeType);
  if (!magic.valid)
    throw new CustomError(
      magic.animated
        ? uploadMsg.animatedNotAllowed(safeName)
        : uploadMsg.contentMismatch(safeName),
      HTTP_STATUS.BAD_REQUEST
    );
  const validatedSvg =
    mimeType === 'image/svg+xml'
      ? validateSvgUpload(buffer, entry.name)
      : undefined;

  return { file: entry, buffer, mimeType, spec, validatedSvg };
}

/**
 * The kind-specific budget, charged once the bytes are in hand and before
 * anything expensive runs on them. Images pay in megapixels of decode work (an
 * SVG is priced by the rasters it embeds), documents in mebibytes. Per USER and
 * shared by both upload routes: an account's allowance is one allowance.
 */
async function chargeUploadBudget(
  userId: EntityID,
  admitted: AdmittedUpload
): Promise<void> {
  if (admitted.spec.kind === 'image') {
    const megapixels =
      admitted.validatedSvg?.embeddedRasterMegapixels ??
      (await measureEncodeCost(admitted.buffer));
    await enforceRateLimit({
      scope: 'upload.image',
      identifier: userIdentifier(userId),
      limit: UPLOAD_MEGAPIXEL_BUDGET,
      cost: Math.max(UPLOAD_REQUEST_UNIT, Math.ceil(megapixels)),
      failClosed: true,
    });
    return;
  }
  await enforceRateLimit({
    scope: 'upload.document',
    identifier: userIdentifier(userId),
    limit: DOCUMENT_BYTE_BUDGET_MIB,
    cost: documentCost(admitted.buffer.byteLength),
    failClosed: true,
  });
}

interface Prepared {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  width: number | undefined;
  height: number | undefined;
  blurhash: string | undefined;
  metadata: Record<string, string>;
}

async function prepare(admitted: AdmittedUpload): Promise<Prepared> {
  if (admitted.spec.kind === 'image') {
    const image = await processImage({
      file: admitted.file,
      buffer: admitted.buffer,
      mimeType: admitted.mimeType,
      validatedSvg: admitted.validatedSvg,
    });
    return {
      buffer: image.buffer,
      mimeType: image.mimeType,
      extension: image.extension,
      sizeBytes: image.sizeBytes,
      width: image.width,
      height: image.height,
      blurhash: image.blurhash,
      metadata:
        image.originalMimeType && image.originalSize !== undefined
          ? {
              originalMimeType: image.originalMimeType,
              originalSize: image.originalSize.toString(),
            }
          : {},
    };
  }
  // Documents are stored byte for byte, under the allowlist's canonical type
  // rather than the client's label with whatever parameters it carried.
  return {
    buffer: admitted.buffer,
    mimeType: admitted.mimeType,
    extension: admitted.spec.extension,
    sizeBytes: admitted.buffer.byteLength,
    width: undefined,
    height: undefined,
    blurhash: undefined,
    metadata: {},
  };
}

/**
 * What a 412 from `If-None-Match: *` means, decided by looking rather than
 * assumed.
 *
 * The key is derived from a fresh row id, so something else at that key is a
 * primary-key collision — EXCEPT that the SDK retries, so a first attempt that
 * committed and lost its response makes the retry a 412 against our OWN object.
 * Returning means the write is ours and the upload continues to activation;
 * anything else throws, and the row is removed only for an object that is
 * provably foreign, since the pending row is the sweep's only record of what to
 * clean up.
 */
async function settleKeyCollision(params: {
  id: EntityID;
  key: string;
  bucketType: BucketType;
  sizeBytes: number;
  sha256: string;
}): Promise<void> {
  const { id, key, bucketType } = params;
  let head: ObjectHead | null;
  try {
    head = await headObjectInR2({ key, bucketType });
  } catch (error) {
    logSanitized('error', error);
    throw new CustomError(mediaMsg.storeFailed, HTTP_STATUS.INTERNAL_ERROR);
  }
  // Our own put always sends the checksum, so an object without one at our key
  // was not written by this request.
  if (head?.checksumSha256 && matchesRow(head, params)) return;
  if (head)
    await db
      .delete(files)
      .where(and(eq(files.id, id), eq(files.status, 'pending')))
      .catch(() => {});
  logSanitized('error', {
    msg: head
      ? 'media.upload key collision'
      : 'media.upload precondition failed with nothing at the key',
    id,
  });
  throw new CustomError(mediaMsg.storeFailed, HTTP_STATUS.INTERNAL_ERROR);
}

/**
 * Store one admitted upload: row, object, activation — in that order, with no
 * transaction open across the object write (`db/limits.ts`).
 *
 * The key is derived from the row's id, so a 412 from `If-None-Match: *` is
 * either our own retried write or a primary-key collision, and `settleKeyCollision`
 * decides which by HEADing the object; NOTHING at the key is ever touched here,
 * because whatever is there that is not ours is someone else's. Any other failed
 * write keeps the `pending` row: a lost response does not prove the object was
 * not written, and the sweep removes the row with whatever the store holds
 * after the TTL. An entity upload is audited with its row and again when it is
 * claimed; a library upload is audited once, when it becomes active.
 */
async function storeUpload(params: {
  admitted: AdmittedUpload;
  target: UploadTarget;
  actor: AuditActor;
}): Promise<MediaFileRow> {
  const { admitted, target, actor } = params;

  let prepared: Prepared;
  try {
    prepared = await prepare(admitted);
  } catch (error) {
    if (error instanceof CustomError) throw error;
    logSanitized('error', error);
    throw new CustomError(mediaMsg.uploadFailed, HTTP_STATUS.INTERNAL_ERROR);
  }

  const id = generateUuidV7();
  const key = objectKey(id, prepared.extension);
  const displayName = `${sanitizeFilename(admitted.file.name)}.${prepared.extension}`;
  const sha256 = createHash('sha256').update(prepared.buffer).digest('hex');

  const pendingRow = {
    id,
    r2Key: key,
    bucketType: target.visibility,
    status: 'pending' as const,
    kind: admitted.spec.kind,
    folderId: target.folderId,
    displayName,
    mimeType: prepared.mimeType,
    sizeBytes: prepared.sizeBytes,
    sha256,
    width: prepared.width,
    height: prepared.height,
    blurhash: prepared.blurhash,
    uploadedBy: actor.userId,
  };
  const audited = {
    displayName,
    folderId: target.folderId,
    kind: admitted.spec.kind,
    mimeType: prepared.mimeType,
    sizeBytes: prepared.sizeBytes,
    bucketType: target.visibility,
    key,
  };

  if (target.activate) await db.insert(files).values(pendingRow);
  else
    await withTransaction(async (tx) => {
      await tx.insert(files).values(pendingRow);
      await auditAs(tx, actor, {
        action: 'INSERT',
        tableName: 'files',
        recordId: id,
        newData: { ...audited, status: 'pending' },
      });
    });

  try {
    await uploadToR2({
      file: prepared.buffer,
      key,
      bucketType: target.visibility,
      ...objectHeaders(
        {
          mimeType: prepared.mimeType,
          kind: admitted.spec.kind,
          filename: displayName,
        },
        target.visibility
      ),
      metadata: prepared.metadata,
      sha256,
      ifNoneMatch: true,
    });
  } catch (error) {
    if (!isPreconditionFailedError(error)) {
      logSanitized('error', error);
      throw new CustomError(mediaMsg.storeFailed, HTTP_STATUS.INTERNAL_ERROR);
    }
    await settleKeyCollision({
      id,
      key,
      bucketType: target.visibility,
      sizeBytes: prepared.sizeBytes,
      sha256,
    });
  }

  if (!target.activate) {
    const [row] = await db
      .select(FILE_COLUMNS)
      .from(files)
      .where(eq(files.id, id));
    if (!row)
      throw new CustomError(mediaMsg.uploadFailed, HTTP_STATUS.INTERNAL_ERROR);
    return row;
  }

  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(files)
      .set({ status: 'active' })
      .where(and(eq(files.id, id), eq(files.status, 'pending')))
      .returning(FILE_COLUMNS);
    if (!row)
      throw new CustomError(mediaMsg.uploadFailed, HTTP_STATUS.INTERNAL_ERROR);

    await auditAs(tx, actor, {
      action: 'INSERT',
      tableName: 'files',
      recordId: id,
      newData: audited,
    });
    return row;
  });
}

/**
 * One upload, from the unread body to the stored row. It reads the body, so
 * whatever must be refused before parsing it — the target's visibility, the
 * admission limit — is the route's to check before calling this.
 */
export async function acceptUpload(
  ctx: HandlerInput,
  actor: AuditActor,
  target: UploadTarget & { field: string }
): Promise<MediaFileRow> {
  // While the body is still an unread stream: the kind budgets can only be
  // charged once it has been buffered.
  await chargeUploadBodyBudget(actor.userId, ctx.headers);

  const entry = takeSingleFile(await ctx.readFormData(), target.field);
  const admitted = await admitUpload(entry, target);
  await chargeUploadBudget(actor.userId, admitted);

  return storeUpload({ admitted, target, actor });
}
