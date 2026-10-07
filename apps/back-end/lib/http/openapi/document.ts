/**
 * Generates a framework-independent contract from the route manifest and the
 * Zod schemas used by handlers. Route-attached Elysia schemas would duplicate
 * validation, while Better Auth's document would advertise blocked routes.
 */
import type { RouteManifestEntry } from '../route-manifest';
import type { JsonSchema } from './json-schema';

import packageManifest from '@/package.json';

import { BETTER_AUTH_ENDPOINTS } from '@/lib/auth/allowed-paths';

import {
  betterAuthDocumentPath,
  betterAuthPathItem,
  referencedBetterAuthSchemas,
  securitySchemes,
} from './better-auth';
import { COMPONENT_SCHEMAS } from './components';
import {
  assertConsistent,
  openApiConsistencyProblems,
  schemaCollisionProblems,
} from './consistency';
import { isJsonSchema, OPENAPI_VERSION } from './json-schema';
import { tableOperation } from './route-operations';
import { successContract } from './success-schemas';

/**
 * The document's version: the application's, plus a digest of the document
 * itself as SemVer build metadata, so two deployments serving different
 * contracts never report the same version. The digest cannot say which one is
 * newer — ⚠️ bump `package.json`'s version with every published contract change
 * once this launches.
 *
 * Computed over the document without `info.version`, which is what it is for.
 */
function documentVersion(document: JsonSchema): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(JSON.stringify(document));
  return `${packageManifest.version}+${hasher.digest('hex').slice(0, 12)}`;
}

/**
 * Throws on an inconsistent table rather than building from it: a contract
 * that is confidently wrong is worse than one that is unavailable, because
 * every client generated from it is wrong the same way.
 */
export function openApiDocument(
  manifest: readonly RouteManifestEntry[] = [],
  withheld: readonly RouteManifestEntry[] = []
): JsonSchema {
  assertConsistent(openApiConsistencyProblems(manifest, withheld));

  const paths: Record<string, JsonSchema> = {};

  for (const entry of manifest) {
    const { path, operation } = tableOperation(entry);
    paths[path] = { ...paths[path], [entry.method.toLowerCase()]: operation };
  }

  for (const endpoint of BETTER_AUTH_ENDPOINTS)
    paths[betterAuthDocumentPath(endpoint.path)] = betterAuthPathItem(endpoint);

  // After `paths`: which Better Auth schemas are merged depends on what the
  // document ended up referencing.
  const betterAuthSchemas = referencedBetterAuthSchemas(paths);
  assertConsistent(schemaCollisionProblems(betterAuthSchemas));

  const document: JsonSchema = {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Dashboard API',
      license: {
        name: 'Private; redistribution is not licensed',
        identifier: 'LicenseRef-Proprietary',
      },
      description:
        'Generated from the server’s own route table and the schemas its handlers validate with, so it describes what the deployment actually serves. Not hand-maintained.',
    },
    servers: [
      {
        url: '/',
        description: 'The same origin that served this document.',
      },
    ],
    tags: [
      {
        name: 'Authentication',
        description: 'Sign-in, sign-out, password recovery, and OTP flows.',
      },
      {
        name: 'Account',
        description: 'Authenticated self-service account changes.',
      },
      {
        name: 'Permissions',
        description: 'Dashboard roles and permission matrices.',
      },
      { name: 'Users', description: 'Dashboard user administration.' },
      {
        name: 'Sessions',
        description: 'User session inspection and revocation.',
      },
      {
        name: 'Media',
        description:
          'The media library: folders, files, and their public/private visibility.',
      },
      {
        name: 'Uploads',
        description:
          'Uploads made for a dashboard record, pending until that record claims them.',
      },
      { name: 'Operations', description: 'Deployment readiness probes.' },
      {
        name: 'Development',
        description: 'Endpoints registered only in development mode.',
      },
      { name: 'Contract', description: 'The generated OpenAPI document.' },
    ],
    components: {
      schemas: {
        ...COMPONENT_SCHEMAS,
        ...successContract().components,
        ...betterAuthSchemas,
      },
      securitySchemes: securitySchemes(),
    },
    paths,
  };

  const info = document.info;
  if (isJsonSchema(info)) info.version = documentVersion(document);
  return document;
}
