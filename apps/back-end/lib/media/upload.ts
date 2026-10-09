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

import { CustomError } from '@app/shared/error-class';
import { sanitizeFilename } from '@app/shared/filename';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg, uploadMsg } from '@app/shared/messages/media';
import {
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  MIB,
} from '@app/shared/validation/constants';
import { normalizeMimeType } from '@app/shared/validation/media-types';

import { MAX_REQUEST_BODY_BYTES } from '@/lib/http/request';
import { serverFault } from '@/lib/http/response';
import { generateUuidV7 } from '@/lib/id';
import {
  headObjectInR2,
  isPreconditionFailedError,
  isVisibilityEnabled,
  uploadToR2,
} from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { bestEffort, errorTypeOf, logSanitized } from '@/utils/log';

import { auditAs } from './actor';
import { fileTypeFor } from './allowlist';
import {
  contentRefused,
  fileTooLarge,
  kindNotAllowed,
  typeNotAllowed,
  visibilityDisabled,
} from './errors';
import { FILE_COLUMNS, matchesRow } from './files';
import { objectHeaders } from './headers';
import { measureEncodeCost } from './image/optimize';
import {
  processImage,
  validateMagicBytes,
  validateSvgUpload,
} from './image/process';
import { objectKey } from './keys';
import { requirePublishGrant } from './policy';

/**
 * In megapixels, not requests: the encoder is process-global and serialized, so
 * a request count lets one account hold it with maximum-size images.
 */
export const UPLOAD_MEGAPIXEL_BUDGET = 100;

/**
 * Floor charge per image request, since even a tiny one costs a parse, a PUT
 * and two writes; `BUDGET / UNIT` is the request ceiling, so move this to move
 * that.
 */
export const UPLOAD_REQUEST_UNIT = 5;

/** In MiB per user per minute: a document is never decoded, so bytes are the cost. */
export const DOCUMENT_BYTE_BUDGET_MIB = 60;
export const DOCUMENT_REQUEST_UNIT = 2;

function documentCost(sizeBytes: number): number {
  return Math.max(DOCUMENT_REQUEST_UNIT, Math.ceil(sizeBytes / MIB));
}

const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE * MIB;
const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_SIZE_MB * MIB;

/**
 * Multipart MiB per user per minute this deployment will buffer, charged from
 * `Content-Length` before parsing: the kind budgets charge only an admitted
 * file, yet a refused body was still parsed in full. Twice the largest kind
 * budget, so it never binds first.
 */
const UPLOAD_BODY_BUDGET_MIB = 2 * DOCUMENT_BYTE_BUDGET_MIB;

/**
 * Each budget must afford the largest request its ceiling admits: `rateLimit`
 * refuses `cost > limit` without a write, a permanent 429. Checked at load
 * because the ceilings live in other files.
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
 * A body without `Content-Length` (chunked) pays the server-wide ceiling, so
 * omitting the header never costs less than stating it.
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
   * The ONE string every downstream check compares: a parameterised type would
   * find its spec yet skip the byte-level checks keyed on the bare type.
   */
  mimeType: string;
  spec: FileTypeSpec;
  validatedSvg?: ValidatedSvgUpload;
}

const MAX_FILES_PER_REQUEST = 1;

/**
 * `formData` is `null` for a non-multipart body.
 *
 * ⚠️ EXACTLY one part: `request.formData()` has already buffered every part, so
 * an extra one would ride along unpriced beside a small admitted file.
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

function maxBytesFor(kind: FileKind): number {
  return kind === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
}

/**
 * `detect` runs on hostile bytes, so a throw is one entry's bug: the bytes are
 * refused and the entry logged, not a 500 on both upload routes.
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

/** Refusals name the file by its sanitised name only. */
export async function admitUpload(
  entry: File,
  target: Pick<UploadTarget, 'kinds'>
): Promise<AdmittedUpload> {
  const safeName = sanitizeFilename(entry.name);

  const mimeType = normalizeMimeType(entry.type);
  const spec = fileTypeFor(mimeType);
  if (!spec) throw typeNotAllowed(mediaMsg.typeNotAllowed(safeName));
  if (!target.kinds.includes(spec.kind))
    throw kindNotAllowed(HTTP_STATUS.BAD_REQUEST);

  if (entry.size > maxBytesFor(spec.kind))
    throw fileTooLarge(
      spec.kind === 'image'
        ? uploadMsg.fileTooLarge(safeName, MAX_IMAGE_SIZE)
        : mediaMsg.documentTooLarge(safeName, MAX_DOCUMENT_SIZE_MB)
    );

  const buffer = Buffer.from(await entry.arrayBuffer());

  const detected = inspect(spec, buffer);
  if (!detected.ok)
    throw contentRefused(mediaMsg.refused(safeName, detected.reason));

  if (spec.kind !== 'image') return { file: entry, buffer, mimeType, spec };

  // The signature check cannot see animation, and the sanitiser is an SVG's
  // only check.
  const magic = validateMagicBytes(buffer, mimeType);
  if (!magic.valid)
    throw contentRefused(
      magic.animated
        ? uploadMsg.animatedNotAllowed(safeName)
        : uploadMsg.contentMismatch(safeName)
    );
  const validatedSvg =
    mimeType === 'image/svg+xml'
      ? validateSvgUpload(buffer, entry.name)
      : undefined;

  return { file: entry, buffer, mimeType, spec, validatedSvg };
}

/**
 * Charged once the bytes are in hand and before anything expensive runs on
 * them. Per user across both upload routes.
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
  // Byte for byte, under the allowlist's type rather than the client's label.
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
 * A 412 from `If-None-Match: *` is a primary-key collision or, because the SDK
 * retries, our own committed write whose response was lost; returning means it
 * is ours. The row is removed only for a provably foreign object: the pending
 * row is the sweep's only record of what to clean up.
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
    throw serverFault(mediaMsg.storeFailed, error);
  }
  // Our own put always sends the checksum, so an object without one at our key
  // was not written by this request.
  if (head?.checksumSha256 && matchesRow(head, params)) return;
  if (head)
    await bestEffort(
      'media.upload pending row delete failed',
      () =>
        db
          .delete(files)
          .where(and(eq(files.id, id), eq(files.status, 'pending'))),
      { id }
    );
  throw serverFault(mediaMsg.storeFailed, {
    msg: head
      ? 'media.upload key collision'
      : 'media.upload precondition failed with nothing at the key',
    id,
  });
}

/**
 * Row, object, activation, with no transaction open across the object write
 * (`db/limits.ts`). An object already at the key is never touched: if not ours,
 * it is someone else's. Any other failed write keeps the `pending` row, since a
 * lost response does not prove nothing was written; the sweep clears both.
 * The audit contract: an entity upload is audited with its row and again when
 * claimed, a library upload once, when it becomes active.
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
    throw serverFault(mediaMsg.uploadFailed, error);
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
    if (!isPreconditionFailedError(error))
      throw serverFault(mediaMsg.storeFailed, error);
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
 * Per user per minute, charged BEFORE the body is read: the kind budgets need
 * the bytes to know the kind, so this bounds the parsing an account over one
 * of them can still cause.
 */
const UPLOAD_ADMISSION_LIMIT = 20;

/** Shared by both upload routes, so the allowance is per user, not per route. */
const UPLOAD_ADMISSION_SCOPE = 'upload.admission';

/**
 * Every upload route's path from its own permission check to the stored row.
 * The publish grant a public target needs comes first, so a caller without it
 * is refused before the admission limit charges it; the charges come before
 * `readFormData()`, which buffers the whole body.
 */
export async function acceptUpload(
  ctx: HandlerInput,
  actor: AuditActor,
  target: UploadTarget & { field: string }
): Promise<MediaFileRow> {
  if (target.visibility === 'public') await requirePublishGrant(ctx.headers);
  if (!isVisibilityEnabled(target.visibility)) throw visibilityDisabled();
  // Per USER: an IP bucket lets one account spend its NAT neighbours' budget.
  // The coarse per-IP bound runs earlier, in the adapter.
  await enforceRateLimit({
    scope: UPLOAD_ADMISSION_SCOPE,
    identifier: userIdentifier(actor.userId),
    limit: UPLOAD_ADMISSION_LIMIT,
    failClosed: true,
  });
  await chargeUploadBodyBudget(actor.userId, ctx.headers);

  const entry = takeSingleFile(await ctx.readFormData(), target.field);
  const admitted = await admitUpload(entry, target);
  await chargeUploadBudget(actor.userId, admitted);

  return storeUpload({ admitted, target, actor });
}
