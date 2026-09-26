import { delay, http } from 'msw';

import { latency } from '../controls';
import { api, fail, MSG } from '../lib/http';
import { session } from '../store';
import { authHandlers } from './auth';
import { contentHandlers } from './content';
import { permissionsHandlers } from './permissions';
import { usersHandlers } from './users';

export const handlers = [
  // Resolvers that return nothing fall through to the next matching handler.
  http.all(api('/api/*'), async () => {
    await delay(latency.get());
  }),
  http.all(api('/api/dash/*'), () =>
    session.get() ? undefined : fail(401, MSG.loginRequired)
  ),
  ...authHandlers,
  ...usersHandlers,
  ...permissionsHandlers,
  ...contentHandlers,
];
