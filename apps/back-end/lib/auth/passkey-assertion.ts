import type { Executor } from '@/db';
import type { Assert } from '@app/shared/api/fields-are-typed';
import type { passkeyRequestOptionsSchema } from '@app/shared/responses/better-auth';
import type { EntityID } from '@app/shared/types';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialRequestOptionsJSON,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';

import { and, eq, lt } from 'drizzle-orm';

import { db } from '@/db';
import { passkeys } from '@/db/schema';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import * as z from 'zod';

import { PUBLIC_ORIGIN } from '@/lib/env';

import { logSanitized } from '@/utils/log';

import { authenticationDenied } from './errors';

// Shared with registration (`two-factor/plugin.ts`), so both halves use one RP identity.
export const RP_ID = new URL(PUBLIC_ORIGIN).hostname;

const transportSchema: z.ZodType<AuthenticatorTransportFuture> = z.enum([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

const transportListSchema = z.array(transportSchema);

function transports(value: string | null) {
  const parsed = transportListSchema.safeParse(value?.split(','));
  return parsed.success ? parsed.data : undefined;
}

type Fits<A, B> = [A] extends [B] ? true : false;
type SameKeys<A, B> = Fits<
  Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>,
  never
>;
type PublishedOptions = z.output<typeof passkeyRequestOptionsSchema>;
type LibraryOptions = PublicKeyCredentialRequestOptionsJSON;

/**
 * The published options schema mirrors the library's type, so an upgrade that
 * changes the type fails here: every value the library builds parses, what
 * parses is the type the browser's ceremony takes (the browser package
 * declares the same interface), and neither names a key the other lacks.
 * Exported only so the compiler keeps checking it; nothing imports it.
 *
 * @knipignore
 */
export type PasskeyOptionsMirrorTheLibrary = Assert<
  [
    Fits<LibraryOptions, z.input<typeof passkeyRequestOptionsSchema>>,
    Fits<PublishedOptions, LibraryOptions>,
    SameKeys<LibraryOptions, PublishedOptions>,
    SameKeys<
      NonNullable<LibraryOptions['extensions']>,
      NonNullable<PublishedOptions['extensions']>
    >,
  ] extends [true, true, true, true]
    ? true
    : false
>;

export async function passkeyOptions(
  userId: EntityID,
  onEmpty: () => never = () => {
    throw authenticationDenied();
  }
) {
  const credentials = await db
    .select({
      credentialID: passkeys.credentialID,
      transports: passkeys.transports,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  if (credentials.length === 0) onEmpty();
  return generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: transports(credential.transports),
    })),
  });
}

// Concurrent assertions may verify against the same old counter. Keep their maximum, never a losing compare-and-swap value.
export async function advancePasskeyCounter(
  passkeyId: string,
  to: number,
  executor: Executor = db
): Promise<boolean> {
  if (to === 0) return true;
  const [advanced] = await executor
    .update(passkeys)
    .set({ counter: to })
    .where(and(eq(passkeys.id, passkeyId), lt(passkeys.counter, to)))
    .returning({ id: passkeys.id });
  return Boolean(advanced);
}

const assertionSchema = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal('public-key'),
  response: z.object({
    authenticatorData: z.string(),
    clientDataJSON: z.string(),
    signature: z.string(),
    userHandle: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
  }),
});

export async function verifyUserPasskey(
  userId: EntityID,
  input: unknown,
  challenge: string
) {
  const parsed = assertionSchema.safeParse(input);
  if (!parsed.success) throw authenticationDenied();
  const response: AuthenticationResponseJSON = {
    ...parsed.data,
    clientExtensionResults: {},
  };
  const [credential] = await db
    .select()
    .from(passkeys)
    .where(
      and(eq(passkeys.userId, userId), eq(passkeys.credentialID, response.id))
    );
  if (!credential) throw authenticationDenied();
  // Only the verifier's own throws are a denial; the read above propagates, so
  // a database fault is answered as one by the caller's boundary.
  let result: VerifiedAuthenticationResponse;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: PUBLIC_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credential.credentialID,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')),
        counter: credential.counter,
      },
      requireUserVerification: true,
    });
  } catch (error) {
    // Why it was rejected; a wrong origin or RP ID is a deployment fault.
    logSanitized('warn', { msg: 'passkey.assertion.rejected', error });
    throw authenticationDenied();
  }
  if (!result.verified) throw authenticationDenied();
  return { credential, newCounter: result.authenticationInfo.newCounter };
}
