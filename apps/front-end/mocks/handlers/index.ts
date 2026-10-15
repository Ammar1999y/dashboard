import { delay, http } from 'msw';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';

import { latency } from '../controls';
import { api, fail, withApiErrors } from '../lib/http';
import { session } from '../store';
import { accountHandlers } from './account';
import { authHandlers } from './auth';
import { contentHandlers } from './content';
import { mediaHandlers } from './media';
import { mediaLibraryHandlers } from './media-library';
import { oauthHandlers } from './oauth';
import { otpFlowHandlers } from './otp-flows';
import { permissionsHandlers } from './permissions';
import { preferencesHandlers } from './preferences';
import { sessionsHandlers } from './sessions';
import { signInChallengeHandlers } from './sign-in-challenge';
import { twoFactorHandlers } from './two-factor';
import { usersHandlers } from './users';

export const handlers = [
  // Resolvers that return nothing fall through to the next matching handler.
  http.all(api('/api/*'), async () => {
    await delay(latency.get());
  }),
  http.all(api('/api/dash/*'), () =>
    session.get()
      ? undefined
      : fail(HTTP_STATUS.UNAUTHORIZED, MSG_LOGIN_REQUIRED)
  ),
  ...authHandlers,
  ...usersHandlers,
  ...sessionsHandlers,
  ...preferencesHandlers,
  ...accountHandlers,
  ...twoFactorHandlers,
  // After the account's: where a path is shared, theirs answers an enrolment
  // and passes on a request that has no session, which a sign-in challenge answers.
  ...signInChallengeHandlers,
  ...otpFlowHandlers,
  ...oauthHandlers,
  ...permissionsHandlers,
  ...contentHandlers,
  ...mediaHandlers,
  ...mediaLibraryHandlers,
].map(withApiErrors);
