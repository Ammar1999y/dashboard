/**
 * What the compiler refuses, so the contract and its binding cannot drift.
 * Every case is an `@ts-expect-error`: `bun run lint` fails when a
 * case stops being an error. The functions are never called; the answers they
 * return are held to the same entries' schemas at runtime below.
 */
import { expect, test } from 'bun:test';

import * as z from 'zod';

import { resetPassword, verifyOtp } from '@app/shared/api/auth';
import { endpoint } from '@app/shared/api/endpoint';
import { uploadMediaFile } from '@app/shared/api/media';
import {
  getPermission,
  listPermissions,
  updatePermission,
} from '@app/shared/api/permissions';
import { updatedAtSchema } from '@app/shared/responses/common';

import { bind } from '@/lib/http/binding';

import { mediaFileWire } from '../helpers/response-fixtures';

const policy = {
  auth: 'permission',
  captcha: false,
  reauth: false,
  rateLimited: true,
  checksPassword: false,
} as const;
const publicPolicy = { ...policy, auth: 'public', rateLimited: false } as const;
const detail = { summary: 'x', tags: ['Permissions'] } as const;
const permission = { resource: 'permissions', action: 'view' } as const;
const rateLimit = { scope: 's', limit: 1, by: 'user' } as const;
const ipRateLimit = { ...rateLimit, by: 'ip' } as const;
const mediaCreate = { resource: 'media', action: 'create' } as const;

const file = {
  ...mediaFileWire(),
  kind: 'image' as const,
  bucketType: 'private' as const,
};
const resetChallenge = {
  reset: false as const,
  twoFactorRequired: true as const,
  grant: 'g',
  options: [],
  defaultMethod: null,
};
const misspelt = { verifed: true as const };
const wrongLiteral = { verified: false as const };
const bareReset = { reset: false as const };
const video = { ...file, kind: 'video' as const };

const refused = [
  () =>
    // @ts-expect-error -- a `:id` path without a params schema
    endpoint({
      method: 'GET',
      path: '/api/x/:id',
      status: 200,
      response: z.null(),
      policy,
    }),
  () =>
    endpoint({
      method: 'GET',
      path: '/api/x',
      // @ts-expect-error -- params on a path that has none
      params: z.object({ id: z.string() }),
      status: 200,
      response: z.null(),
      policy,
    }),
  () =>
    // @ts-expect-error -- a permission route without its permission
    bind(getPermission, {
      rateLimit,
      failure: 'x',
      detail,
      handler: async () => ({ message: 'x', data: getPermissionData() }),
    }),
  () =>
    bind(
      endpoint({
        method: 'GET',
        path: '/api/y',
        status: 200,
        response: z.null(),
        policy: publicPolicy,
      }),
      {
        // @ts-expect-error -- a limiter the policy does not declare
        rateLimit,
        failure: 'x',
        detail,
        handler: async () => ({ message: 'x', data: null }),
      }
    ),
  () =>
    bind(
      endpoint({
        method: 'GET',
        path: '/api/z',
        status: 200,
        response: z.null(),
        policy: { ...publicPolicy, rateLimited: true },
      }),
      {
        // @ts-expect-error -- a public route has no user to count
        rateLimit,
        failure: 'x',
        detail,
        handler: async () => ({ message: 'x', data: null }),
      }
    ),
  () =>
    bind(getPermission, {
      permission,
      rateLimit,
      // @ts-expect-error -- a JSON ceiling on a bodyless route
      maxJsonBodyBytes: 10,
      failure: 'x',
      detail,
      handler: async () => ({ message: 'x', data: getPermissionData() }),
    }),
  () =>
    bind(updatePermission, {
      permission,
      rateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- a `Date` where the response schema says string
      handler: async () => ({ message: 'x', data: { updatedAt: new Date() } }),
    }),
  () =>
    bind(listPermissions, {
      permission,
      rateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- a list answer without its `meta`
      handler: async () => ({ message: 'x', data: [] }),
    }),
  () =>
    bind(updatePermission, {
      permission,
      rateLimit,
      failure: 'x',
      detail,
      handler: async ({ body }) => {
        // @ts-expect-error -- the handler reads the body's OUTPUT type
        const unknownField: string = body.unknownField;
        return { message: unknownField, data: { updatedAt: '' } };
      },
    }),
  () =>
    bind(verifyOtp, {
      rateLimit: ipRateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- the field is `verified`
      handler: async () => ({ message: 'x', data: misspelt }),
    }),
  () =>
    bind(verifyOtp, {
      rateLimit: ipRateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- `verified` is the literal `true`
      handler: async () => ({ message: 'x', data: wrongLiteral }),
    }),
  () =>
    bind(resetPassword, {
      rateLimit: ipRateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- `reset: false` is the branch that carries a grant
      handler: async () => ({ message: 'x', data: bareReset }),
    }),
  () =>
    bind(uploadMediaFile, {
      permission: mediaCreate,
      rateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- `kind` is `image` or `document`
      handler: async () => ({ message: 'x', data: video }),
    }),
  () =>
    bind(verifyOtp, {
      rateLimit: ipRateLimit,
      failure: 'x',
      detail,
      // @ts-expect-error -- only an entry whose response is raw answers raw
      handler: async () => ({ raw: { verified: true } }),
    }),
];

/** The same machinery accepts what each refusal above gets wrong. */
const accepted = [
  () =>
    bind(verifyOtp, {
      rateLimit: ipRateLimit,
      failure: 'x',
      detail,
      handler: async () => ({
        message: 'x',
        data: { verified: true as const },
      }),
    }),
  () =>
    bind(resetPassword, {
      rateLimit: ipRateLimit,
      failure: 'x',
      detail,
      handler: async () => ({ message: 'x', data: resetChallenge }),
    }),
  () =>
    bind(uploadMediaFile, {
      permission: mediaCreate,
      rateLimit,
      failure: 'x',
      detail,
      handler: async () => ({ message: 'x', data: file }),
    }),
  () =>
    bind(listPermissions, {
      permission,
      rateLimit,
      failure: 'x',
      detail,
      handler: async () => ({
        message: 'x',
        data: [],
        meta: { page: 1, perPage: 10, total: 0, pageCount: 0 },
      }),
    }),
];

function getPermissionData(): z.input<typeof getPermission.response> {
  throw new Error('never called');
}

test('the compiler refuses each case above', () => {
  expect(refused).toHaveLength(14);
  expect(accepted).toHaveLength(4);
  expect(updatedAtSchema.safeParse({ updatedAt: new Date() }).success).toBe(
    false
  );
});

test('each entry’s schema refuses at runtime what its type refuses', () => {
  const parses = (schema: z.ZodType, data: unknown) =>
    schema.safeParse(data).success;
  expect([
    parses(verifyOtp.response, misspelt),
    parses(verifyOtp.response, wrongLiteral),
    parses(resetPassword.response, bareReset),
    parses(uploadMediaFile.response, video),
  ]).toEqual([false, false, false, false]);
  expect([
    parses(verifyOtp.response, { verified: true }),
    parses(resetPassword.response, resetChallenge),
    parses(uploadMediaFile.response, file),
  ]).toEqual([true, true, true]);
});
