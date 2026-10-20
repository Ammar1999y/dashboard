import type {
  oauthOutcomeSchema,
  passwordlessResultSchema,
  twoFactorChallengeSchema,
} from '@app/shared/responses/better-auth';
import type * as z from 'zod';

import { authCapabilities } from '@app/shared/api/better-auth';

export type TwoFactorChallenge = z.output<typeof twoFactorChallengeSchema>;

export type TwoFactorOption = TwoFactorChallenge['twoFactorOptions'][number];

export type SignInResult =
  | z.output<typeof passwordlessResultSchema>
  | z.output<typeof oauthOutcomeSchema>;

export const providersSchema = authCapabilities.response.raw.transform(
  ({ data }) => data.oauthProviders
);
