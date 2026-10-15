import { createdIdSchema } from '../responses/common';
import { devSignUpSchema } from '../validation/dev';
import { endpoint } from './endpoint';

/** Development only: the server neither serves nor publishes it elsewhere. */
export const devSignUp = endpoint({
  method: 'POST',
  path: '/api/dev/sign-up',
  body: devSignUpSchema,
  status: 201,
  response: createdIdSchema,
  errors: { 409: {} },
  policy: {
    auth: 'public',
    captcha: false,
    reauth: false,
    rateLimited: false,
    checksPassword: false,
  },
});
