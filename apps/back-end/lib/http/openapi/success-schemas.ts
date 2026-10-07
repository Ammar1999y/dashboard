/**
 * The success responses of the route table and of this project's own Better
 * Auth plugin endpoints, converted from the shared response schemas
 * (`@app/shared/response-contract`). Nothing here restates a shape:
 * this file adds only what the document says and the browser bundle must not
 * carry, and decides which schemas are published once as components.
 */
import type { JsonSchema } from './json-schema';

import * as z from 'zod';

import {
  BETTER_AUTH_RESPONSES,
  isBetterAuthResponseRoute,
  isResponseRoute,
  RESPONSE_DATA,
  responseEnvelope,
} from '@app/shared/response-contract';
import { reauthGrantSchema } from '@app/shared/responses/auth';
import {
  passkeyRequestOptionsSchema,
  removedMethodSchema,
  twoFactorChallengeSchema,
} from '@app/shared/responses/better-auth';
import {
  createdFolderSchema,
  deletedFilesSchema,
  deletedFolderSchema,
  folderListingSchema,
  mediaFileDetailsSchema,
  mediaFileSchema,
  mediaFolderHitSchema,
  mediaFolderSchema,
  mediaUsageSchema,
  movedFilesSchema,
  searchListingSchema,
  unfiledListingSchema,
  updatedFileSchema,
  updatedFolderSchema,
  uploadedFilesSchema,
} from '@app/shared/responses/media';
import {
  storedPreferencesSchema,
  userDetailSchema,
} from '@app/shared/responses/users';
import { preferencesSchema } from '@app/shared/validation/preferences';

import { componentRef } from './components';
import { toJsonSchema } from './json-schema';

/**
 * Published once under `components.schemas`, and referenced from every other
 * use of the same instance.
 */
export const RESPONSE_COMPONENTS = [
  { name: 'MediaFile', schema: mediaFileSchema },
  { name: 'MediaFileDetails', schema: mediaFileDetailsSchema },
  { name: 'MediaFolder', schema: mediaFolderSchema },
  { name: 'MediaFolderHit', schema: mediaFolderHitSchema },
  { name: 'MediaUsage', schema: mediaUsageSchema },
  { name: 'TwoFactorChallenge', schema: twoFactorChallengeSchema },
  { name: 'PasskeyRequestOptions', schema: passkeyRequestOptionsSchema },
] as const satisfies readonly { name: string; schema: z.ZodType }[];

export type ResponseComponentName =
  (typeof RESPONSE_COMPONENTS)[number]['name'];

const COMPONENT_REFS = new Map<z.core.$ZodType, JsonSchema>([
  ...RESPONSE_COMPONENTS.map(
    ({ name, schema }): [z.core.$ZodType, JsonSchema] => [
      schema,
      componentRef(name),
    ]
  ),
  // The upload answer's element only adds a client-side rule (a non-empty
  // `url`), so the document keeps publishing it as the component.
  [uploadedFilesSchema.element, componentRef('MediaFile')],
]);

const STORED_NAME = 'The stored, normalised name.';
const STORED_NAME_IF_SENT = `${STORED_NAME} Present when one was sent.`;

/**
 * What the document says about a shared response schema beyond the schema
 * itself, by instance: prose, which the browser bundle must not carry, and
 * `dependentRequired`, which `z.fromJSONSchema` cannot read back. Keyed by
 * instance rather than by route, because a component's prose would otherwise
 * repeat on every route that returns it.
 */
const DOCUMENT_KEYWORDS = new Map<z.core.$ZodType, JsonSchema>([
  [
    mediaFileSchema.shape.transition,
    {
      description:
        'Non-null while a visibility change is in flight, and each value tells a client something different: `to_public`/`to_private` mean the copy is being made and verified and `url` still answers from the OLD bucket, so the change is in progress; `cleanup` means the flip is done and `url` is final, and only the stale copy in the other bucket (and, for a public one, its edge cache) is still being removed by the nightly sweep — nothing is pending for the client. `url` always points at the current bucket. Removing the object from the origin is unconditional; evicting an edge copy needs the configured cache purge; a copy already in a browser stays readable until its `Cache-Control` lifetime ends and cannot be recalled.',
    },
  ],
  [
    mediaFileSchema.shape.folderId,
    {
      description:
        'Null for a file uploaded for a record rather than into the library.',
    },
  ],
  [
    mediaFileSchema.shape.unfiledAt,
    {
      description:
        'When the nightly sweep first found the file unfiled — active, in no folder, referenced by no record. It is deleted `retentionDays` (see `scope=unfiled`) after this unless moved into a folder; null otherwise.',
    },
  ],
  [
    mediaFileSchema.shape.url,
    {
      description:
        'Permanent public URL for a public object; otherwise a signed URL valid for one hour. Never store it.',
    },
  ],
  [
    mediaFileDetailsSchema.shape.downloadUrl,
    {
      description:
        'Signed URL, valid for one hour, that downloads the file under its current display name.',
    },
  ],
  [
    mediaFileDetailsSchema.shape.usedBy,
    { description: 'Owners the caller may view.' },
  ],
  [
    mediaFileDetailsSchema.shape.hiddenUsages,
    { description: 'Owners on pages the caller may not view.' },
  ],
  [
    mediaFolderSchema.shape.parentId,
    { description: 'Null for a root folder.' },
  ],
  [
    mediaFolderHitSchema.shape.breadcrumbs,
    { description: 'Root → the folder itself.' },
  ],
  [
    uploadedFilesSchema,
    {
      description:
        'One pending file. It is not listable until the record it is for is saved and claims it.',
    },
  ],
  [
    folderListingSchema.shape.visibilities,
    { description: 'The buckets this deployment has configured.' },
  ],
  [
    folderListingSchema.shape.canPublish,
    { description: 'Whether the caller holds `media.publish`.' },
  ],
  [
    folderListingSchema,
    {
      description:
        'The folder view (`scope=folder`): breadcrumbs from the root, the subfolders, and one page of files.',
    },
  ],
  [
    searchListingSchema,
    {
      description:
        'The library search (`scope=all`): one page of files across every folder and, when `search` is given, up to twenty folders whose name matches, each with its path from the root.',
    },
  ],
  [
    searchListingSchema.shape.foldersTruncated,
    {
      description:
        'More folders match than the twenty returned. The files beside them are fully paginated through `meta`; the folder hits are a navigation aid and are capped, so a narrower `search` is the way to reach the rest.',
    },
  ],
  [
    unfiledListingSchema,
    {
      description:
        'The unfiled view (`scope=unfiled`): one page of active files in no folder that no record references — uploads whose record is gone. Each is deleted `retentionDays` after its `unfiledAt` stamp unless moved into a folder with `PUT /api/dash/media/files/{id}`.',
    },
  ],
  [
    unfiledListingSchema.shape.retentionDays,
    { description: 'Days an unfiled file survives after `unfiledAt`.' },
  ],
  [
    deletedFilesSchema.shape.deleted,
    { description: 'Gone from the database and from the object store.' },
  ],
  [
    deletedFilesSchema.shape.pending,
    {
      description:
        'Committed to deletion and already gone from every listing and every media route, but the object store refused the delete or the configured cache purge failed; the nightly sweep finishes them. There is no completion signal and none is needed: these ids never come back, and no endpoint reports their progress. An edge copy is evicted only when the purge is configured; a copy already in a browser stays readable until its `Cache-Control` lifetime ends and cannot be recalled.',
    },
  ],
  [
    movedFilesSchema.shape.unfiledAt,
    { description: 'Every moved file is filed.' },
  ],
  [updatedFileSchema.shape.displayName, { description: STORED_NAME_IF_SENT }],
  [
    updatedFileSchema.shape.unfiledAt,
    { description: 'Present when a folder was sent: filing clears it.' },
  ],
  [createdFolderSchema.shape.name, { description: STORED_NAME }],
  [updatedFolderSchema.shape.name, { description: STORED_NAME_IF_SENT }],
  [
    deletedFolderSchema.shape.folders,
    {
      description:
        'Folder rows removed. `0` from a recursive delete whose FILES went but whose folders could not: something was still in the tree — a file the sweep has yet to finish removing, or an upload that arrived while the files were being deleted. Retry once it settles.',
    },
  ],
  [
    deletedFolderSchema.shape.deleted,
    {
      description:
        'Files gone from the database and from the object store. Always empty for a non-recursive delete, which refuses a folder that holds anything.',
    },
  ],
  [
    deletedFolderSchema.shape.pending,
    {
      description:
        'Files committed to deletion and already gone from every listing, whose object or configured cache purge the nightly sweep still has to finish.',
    },
  ],
  [
    reauthGrantSchema.shape.expiresIn,
    {
      description:
        'Seconds the window lasts. It is bound to THIS session — there is no token to send back, the same cookie carries it.',
    },
  ],
  [
    preferencesSchema.shape.preset,
    {
      description:
        'A theme preset the client resolves. It falls back to its built-in theme for one it does not know, so this server does not hold the list.',
    },
  ],
  [
    storedPreferencesSchema.shape.updatedAt,
    {
      description:
        'Server-side write time. Null only when nothing has ever been saved, so a stored choice of the defaults is distinguishable from no choice.',
    },
  ],
  [
    userDetailSchema,
    {
      dependentRequired: {
        sessions: ['sessionsHasMore', 'sessionsNextCursor'],
        sessionsHasMore: ['sessions', 'sessionsNextCursor'],
        sessionsNextCursor: ['sessions', 'sessionsHasMore'],
      },
    },
  ],
  [
    twoFactorChallengeSchema,
    {
      description:
        'The first factor succeeded and the login is NOT complete: no session cookie is set, and one of the options below has to be verified next.',
    },
  ],
  [
    twoFactorChallengeSchema.shape.twoFactorMethods,
    {
      description:
        'Distinct method names. Two OTP channels collapse into one entry here, so it cannot drive a choice — use `twoFactorOptions`.',
    },
  ],
  [
    twoFactorChallengeSchema.shape.twoFactorOptions.element.shape.id,
    {
      description:
        'Stable option identity: `totp`, `backup_code`, `passkey`, `otp:email` or `otp:phone`.',
    },
  ],
  [
    twoFactorChallengeSchema.shape.twoFactorOptions.element.shape.nextAllowedIn,
    {
      description:
        '`otp` options only: seconds before a code may be sent to this contact. `0` means a send is allowed now.',
    },
  ],
  [
    twoFactorChallengeSchema.shape.defaultMethod,
    {
      description:
        '`null` means ask: only recovery material is left, and a backup code is never auto-routed to.',
    },
  ],
  [
    removedMethodSchema.shape.removedMethod,
    {
      description:
        'The option that is gone, `otp:email` / `otp:phone` / `totp` / `backup_code` / `passkey`.',
    },
  ],
]);

interface SuccessContract {
  /** Under `components.schemas`, each converted as a root. */
  components: Record<string, JsonSchema>;
  /** Each route's whole success body, envelope included. */
  envelopes: ReadonlyMap<string, JsonSchema>;
  /** Each plugin endpoint's whole 2xx body, keyed by its path under the prefix. */
  betterAuth: ReadonlyMap<string, JsonSchema>;
  /** `keywords` entries that no conversion reached. */
  unusedKeywords: string[];
}

/** `keywords` is injectable so the leftover check can be shown to fire. */
export function convertContract(
  keywords: ReadonlyMap<z.core.$ZodType, JsonSchema> = DOCUMENT_KEYWORDS
): SuccessContract {
  const used = new Set<z.core.$ZodType>();
  const convert = (root: z.ZodType): JsonSchema => {
    const rootSchema: z.core.$ZodType = root;
    return toJsonSchema(root, {
      override: ({ zodSchema, jsonSchema }) => {
        const ref =
          zodSchema === rootSchema ? undefined : COMPONENT_REFS.get(zodSchema);
        if (ref) {
          for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
          Object.assign(jsonSchema, ref);
          return;
        }
        const added = keywords.get(zodSchema);
        if (!added) return;
        Object.assign(jsonSchema, added);
        used.add(zodSchema);
      },
    });
  };

  return {
    components: Object.fromEntries(
      RESPONSE_COMPONENTS.map(({ name, schema }) => [name, convert(schema)])
    ),
    envelopes: new Map(
      Object.keys(RESPONSE_DATA)
        .filter(isResponseRoute)
        .map((key) => [key, convert(responseEnvelope(key))])
    ),
    betterAuth: new Map(
      Object.keys(BETTER_AUTH_RESPONSES)
        .filter(isBetterAuthResponseRoute)
        .map((path) => [path, convert(BETTER_AUTH_RESPONSES[path])])
    ),
    unusedKeywords: [...keywords]
      .filter(([schema]) => !used.has(schema))
      .map(([, added]) => JSON.stringify(added).slice(0, 80)),
  };
}

const converted: { contract: SuccessContract | undefined } = {
  contract: undefined,
};

/** Converted once per process: every input is static. */
export function successContract(): SuccessContract {
  converted.contract ??= convertContract();
  return converted.contract;
}

/** The success body `key` publishes. */
export function successBodySchema(key: string): JsonSchema {
  const body = successContract().envelopes.get(key);
  if (!body) throw new Error(`No success schema for ${key}`);
  return body;
}

/** The 2xx body the plugin endpoint at `path` publishes, if it is one of ours. */
export function betterAuthSuccessSchema(path: string): JsonSchema | undefined {
  return successContract().betterAuth.get(path);
}
