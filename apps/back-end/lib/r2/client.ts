import type { BucketType } from '@app/shared/validation/enums';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET } from './buckets';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '');

const MAX_PRESIGNED_URL_EXPIRY = 604_800;
const MIN_PRESIGNED_URL_EXPIRY = 1;
const DEFAULT_PRESIGNED_URL_EXPIRY = 3600;

/** `DeleteObjects` refuses a call with more keys (`MalformedXML`). */
const DELETE_OBJECTS_MAX_KEYS = 1000;

const R2_NOT_CONFIGURED =
  'R2 is not configured. Please check environment variables.';

const validateR2Config = !!(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY
);

/**
 * The deadlines the SDK does not have: its HTTP handler sets neither by
 * default, so a hung R2 socket outlives the route, and `requestTimeout` only
 * warns unless `throwOnRequestTimeout` is set.
 *
 * `requestTimeout` covers the body upload too, so it must fit the largest object
 * written (`MAX_DOCUMENT_SIZE_MB`), and `maxAttempts` times it must stay under
 * the destructive media routes' declared `timeoutSeconds`.
 */
const R2_CONNECTION_TIMEOUT_MS = 3000;
const R2_REQUEST_TIMEOUT_MS = 15_000;

const r2Client = new S3Client({
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
  // The signing scope Cloudflare documents; a location hint is not a region.
  region: 'auto',
  // Options rather than a constructed handler, so `@smithy/node-http-handler`,
  // a transitive dependency only, is never imported.
  requestHandler: {
    connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
    requestTimeout: R2_REQUEST_TIMEOUT_MS,
    throwOnRequestTimeout: true,
  },
  // Stated although they are the SDK defaults: every route timeout that reaches
  // R2 is sized on `maxAttempts`, and `uploadToR2` relies on the checksums.
  maxAttempts: 3,
  requestChecksumCalculation: 'WHEN_SUPPORTED',
  responseChecksumValidation: 'WHEN_SUPPORTED',
});

/**
 * The visibilities this deployment can store, decided once from which bucket
 * names are configured. `lib/env.server.ts` enforces the combinations that make
 * sense; this only reports which halves exist.
 */
export const ENABLED_VISIBILITIES: ReadonlySet<BucketType> =
  new Set<BucketType>([
    ...(R2_PUBLIC_BUCKET ? (['public'] as const) : []),
    ...(R2_PRIVATE_BUCKET ? (['private'] as const) : []),
  ]);

export function isVisibilityEnabled(bucketType: BucketType): boolean {
  return ENABLED_VISIBILITIES.has(bucketType);
}

/**
 * Resolves a bucket, or refuses. `validateR2Config` covers the credentials only,
 * so without this an unset bucket reaches the SDK as `Bucket: undefined`.
 */
const getBucketName = (bucketType: BucketType): string => {
  const bucket = bucketType === 'public' ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET;
  if (!bucket)
    throw new Error(
      `R2 is not configured: ${
        bucketType === 'public' ? 'R2_PUBLIC_BUCKET' : 'R2_PRIVATE_BUCKET'
      } is unset.`
    );
  return bucket;
};

function assertR2Configured(): void {
  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);
}

function configuredBucket(bucketType: BucketType): string {
  assertR2Configured();
  return getBucketName(bucketType);
}

/** A hex SHA-256 in the base64 form R2 takes and returns as `ChecksumSHA256`. */
export function checksumSha256Of(sha256Hex: string): string {
  return Buffer.from(sha256Hex, 'hex').toString('base64');
}

/**
 * Per-segment percent-encoding, for the two places a key travels inside a URL
 * or a header rather than as a request parameter: `x-amz-copy-source`, which
 * refuses a raw non-ASCII key, and the public URL.
 */
function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function errorField(error: unknown, field: string): unknown {
  return error && typeof error === 'object' && field in error
    ? Reflect.get(error, field)
    : undefined;
}

function httpStatusOf(error: unknown): number | undefined {
  const metadata = errorField(error, '$metadata');
  const status = errorField(metadata, 'httpStatusCode');
  return typeof status === 'number' ? status : undefined;
}

/** `HeadObject` on a missing key (`NotFound`), or `GetObject`/`CopyObject` on one (`NoSuchKey`). */
function isNotFoundError(error: unknown): boolean {
  const name = errorField(error, 'name');
  return (
    name === 'NotFound' || name === 'NoSuchKey' || httpStatusOf(error) === 404
  );
}

/** `PutObject` with `If-None-Match: *` against a key that already exists. */
export function isPreconditionFailedError(error: unknown): boolean {
  return (
    errorField(error, 'name') === 'PreconditionFailed' ||
    httpStatusOf(error) === 412
  );
}

export async function uploadToR2(params: {
  file: Buffer;
  key: string;
  bucketType: BucketType;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  /**
   * Hex SHA-256 of `file`, sent as the object's checksum: R2 verifies it on the
   * write and returns it on a later `HeadObject` (a copy does not inherit it).
   * Required, because `settleKeyCollision` reads it back to tell this client's
   * own retry from a foreign object at the same key.
   */
  sha256: string;
  /**
   * `If-None-Match: *`. A 412 is then either a bug or this client's own retry of
   * a write that committed and lost its response; `lib/media/upload.ts` decides
   * which.
   */
  ifNoneMatch?: boolean;
}): Promise<{ success: boolean; key: string }> {
  const {
    file,
    key,
    bucketType,
    contentType,
    cacheControl,
    contentDisposition,
    metadata,
    sha256,
    ifNoneMatch,
  } = params;

  const bucket = configuredBucket(bucketType);

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file,
      ContentType: contentType,
      CacheControl: cacheControl,
      ContentDisposition: contentDisposition,
      Metadata: metadata,
      ChecksumSHA256: checksumSha256Of(sha256),
      ...(ifNoneMatch && { IfNoneMatch: '*' }),
    })
  );

  return { success: true, key };
}

export async function deleteFromR2(params: {
  key: string;
  bucketType: BucketType;
}): Promise<{ success: boolean }> {
  const { key, bucketType } = params;

  const bucket = configuredBucket(bucketType);

  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return { success: true };
}

/**
 * Batch delete, chunked to the per-call ceiling.
 *
 * R2 reports a missing key as deleted, so a retry of a half-finished batch is
 * clean. `failed` carries the keys R2 refused inside an otherwise successful
 * call; a call that throws as a whole propagates, because then nothing about
 * the chunk is known.
 */
export async function deleteObjectsFromR2(params: {
  keys: readonly string[];
  bucketType: BucketType;
}): Promise<{ deleted: string[]; failed: string[] }> {
  const { keys, bucketType } = params;
  const bucket = configuredBucket(bucketType);

  const deleted: string[] = [];
  const failed: string[] = [];
  for (let start = 0; start < keys.length; start += DELETE_OBJECTS_MAX_KEYS) {
    const chunk = keys.slice(start, start + DELETE_OBJECTS_MAX_KEYS);
    const result = await r2Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      })
    );
    const errors = result.Errors ?? [];
    // An error entry without a `Key`, which the SDK's type permits, names no
    // object, so nothing in the chunk is confirmed deleted.
    if (errors.some((entry) => typeof entry.Key !== 'string')) {
      failed.push(...chunk);
      continue;
    }
    const refused = new Set(errors.map((entry) => entry.Key));
    for (const key of chunk) (refused.has(key) ? failed : deleted).push(key);
  }
  return { deleted, failed };
}

/**
 * Server-side copy, within a bucket or across the two.
 *
 * `replace` restates the object's headers (`MetadataDirective: REPLACE`); without
 * it R2 copies them verbatim. A cross-bucket copy MUST replace: an object's
 * `Cache-Control` belongs to the bucket it is in.
 */
export async function copyFileInR2(params: {
  sourceKey: string;
  destinationKey: string;
  bucketType: BucketType;
  /** Defaults to `bucketType`: a copy within one bucket. */
  sourceBucketType?: BucketType;
  replace?: {
    contentType: string;
    cacheControl: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
  };
}): Promise<{ success: boolean; newKey: string }> {
  const { sourceKey, destinationKey, bucketType, replace } = params;

  const bucket = configuredBucket(bucketType);
  const sourceBucket = getBucketName(params.sourceBucketType ?? bucketType);

  await r2Client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${sourceBucket}/${encodeObjectKey(sourceKey)}`,
      Key: destinationKey,
      ...(replace && {
        MetadataDirective: 'REPLACE',
        ContentType: replace.contentType,
        CacheControl: replace.cacheControl,
        ContentDisposition: replace.contentDisposition,
        Metadata: replace.metadata,
      }),
    })
  );

  return { success: true, newKey: destinationKey };
}

export interface ObjectHead {
  contentLength: number | null;
  contentType: string | null;
  /** Quoted, as R2 returns it. The content MD5 for a single-part object. */
  etag: string | null;
  /** Base64, present only for an object written with `sha256`; a copy does not carry it. */
  checksumSha256: string | null;
}

/** `null` when the key does not exist; every other failure propagates. */
export async function headObjectInR2(params: {
  key: string;
  bucketType: BucketType;
}): Promise<ObjectHead | null> {
  const bucket = configuredBucket(params.bucketType);
  try {
    const head = await r2Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: params.key,
        ChecksumMode: 'ENABLED',
      })
    );
    return {
      contentLength:
        typeof head.ContentLength === 'number' ? head.ContentLength : null,
      contentType: head.ContentType ?? null,
      etag: head.ETag ?? null,
      checksumSha256: head.ChecksumSHA256 ?? null,
    };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

interface ListedObject {
  key: string;
  size: number;
}

/**
 * One page of keys under a prefix. R2 caps a page whatever `MaxKeys` asks for,
 * so callers loop on `nextContinuationToken`.
 */
export async function listObjectsInR2(params: {
  bucketType: BucketType;
  prefix: string;
  continuationToken?: string;
}): Promise<{ objects: ListedObject[]; nextContinuationToken: string | null }> {
  const bucket = configuredBucket(params.bucketType);
  const page = await r2Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: params.prefix,
      MaxKeys: 1000,
      ContinuationToken: params.continuationToken,
    })
  );
  return {
    objects: (page.Contents ?? []).flatMap((entry) =>
      typeof entry.Key === 'string'
        ? [{ key: entry.Key, size: entry.Size ?? 0 }]
        : []
    ),
    nextContinuationToken: page.IsTruncated
      ? (page.NextContinuationToken ?? null)
      : null,
  };
}

export async function getPresignedUrl(params: {
  key: string;
  bucketType: BucketType;
  expiresIn?: number;
  responseContentDisposition?: string;
}): Promise<string> {
  const {
    key,
    bucketType,
    expiresIn = DEFAULT_PRESIGNED_URL_EXPIRY,
    responseContentDisposition,
  } = params;

  assertR2Configured();

  const validExpiry = Math.max(
    MIN_PRESIGNED_URL_EXPIRY,
    Math.min(expiresIn, MAX_PRESIGNED_URL_EXPIRY)
  );

  if (validExpiry !== expiresIn) {
    // `warn`: the value was clamped and the request proceeds.
    console.warn(
      JSON.stringify({
        msg: 'r2.presign expiry clamped',
        requested: expiresIn,
        used: validExpiry,
        min: MIN_PRESIGNED_URL_EXPIRY,
        max: MAX_PRESIGNED_URL_EXPIRY,
      })
    );
  }

  const bucket = getBucketName(bucketType);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: responseContentDisposition,
  });

  const url = await getSignedUrl(r2Client, command, {
    expiresIn: validExpiry,
  });

  return url;
}

/**
 * Whether public objects can be addressed without signing. Absent in
 * development is supported (`lib/env.server.ts`); the URL builders then fall
 * back to a presigned GET on the public bucket, which works but expires.
 */
export function hasPublicUrl(): boolean {
  return Boolean(R2_PUBLIC_URL);
}

export function getPublicUrl(key: string): string {
  if (!R2_PUBLIC_URL) {
    throw new Error(
      'R2_PUBLIC_URL not configured. ' +
        'Attach a custom domain to the public bucket and add R2_PUBLIC_URL to .env'
    );
  }

  return `${R2_PUBLIC_URL}/${encodeObjectKey(key)}`;
}

/**
 * PRESENCE only, for every field: a status report must never carry a
 * configuration value, whoever ends up exposing it.
 *
 * @knipignore
 */
export function getR2ConfigStatus() {
  return {
    configured: validateR2Config,
    accountId: !!R2_ACCOUNT_ID,
    accessKeyId: !!R2_ACCESS_KEY_ID,
    secretAccessKey: !!R2_SECRET_ACCESS_KEY,
    publicBucket: !!R2_PUBLIC_BUCKET,
    privateBucket: !!R2_PRIVATE_BUCKET,
    publicUrl: !!R2_PUBLIC_URL,
  };
}
