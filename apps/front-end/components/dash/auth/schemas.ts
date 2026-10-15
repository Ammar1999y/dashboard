import type {
  oauthOutcomeSchema,
  passwordlessResultSchema,
  twoFactorChallengeSchema,
} from '@app/shared/responses/better-auth';

import * as z from 'zod';
import { capabilitiesSchema } from '@app/shared/responses/better-auth';

export type TwoFactorChallenge = z.output<typeof twoFactorChallengeSchema>;

export type TwoFactorOption = TwoFactorChallenge['twoFactorOptions'][number];

/** `/sign-in/email` answering a session, and the library's TOTP and backup-code verifiers. */
export const signedInSchema = z.object({ user: z.object({ id: z.string() }) });

export type SignInResult =
  | z.output<typeof passwordlessResultSchema>
  | z.output<typeof oauthOutcomeSchema>;

export const providersSchema = capabilitiesSchema.transform(
  ({ oauthProviders }) => oauthProviders
);
