import { delay, http } from 'msw';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';

import { latency } from '../controls';
import { api, fail, withApiErrors } from '../lib/http';
import { session } from '../store';
import { authHandlers } from './auth';
import { contentHandlers } from './content';
import { mediaHandlers } from './media';
import { permissionsHandlers } from './permissions';
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
  ...permissionsHandlers,
  ...contentHandlers,
  ...mediaHandlers,
].map(withApiErrors);
