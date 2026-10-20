import type { NextRouter } from 'next/router';

import { OAUTH_STATE_LOST_PAGE } from '@app/shared/validation/oauth';

import { validateRedirectPath } from '@/utils/validate-redirect-path';

export const SIGN_IN_PATH = '/dash/sign-in';
export const ACCOUNT_PATH = '/dash/account';
export const FORGOT_PASSWORD_PATH = '/dash/forgot-password';
const FROM_PARAM = 'from';

/** The account page, opened from `from`, which it returns to once the user is done. */
export const accountPath = (from: string) =>
  `${ACCOUNT_PATH}?${new URLSearchParams({ [FROM_PARAM]: from })}`;

/** The page the account page was opened from, when it names a safe one. */
export function accountReturnPath(query: NextRouter['query']): string | null {
  const from = query[FROM_PARAM];
  return typeof from === 'string'
    ? validateRedirectPath(from, '') || null
    : null;
}

/** Where Google's callback lands; the server resolves it against its own origin. */
export const OAUTH_COMPLETE_PATH = '/dash/oauth-complete';

const REASON_PARAM = 'reason';
const EMAIL_CHANGED_REASON = 'email-changed';

/** Where an email change sends the browser once every session of the account has ended. */
export const EMAIL_CHANGED_SIGN_IN_PATH = `${SIGN_IN_PATH}?${REASON_PARAM}=${EMAIL_CHANGED_REASON}`;

export const isEmailChanged = (query: NextRouter['query']) =>
  query[REASON_PARAM] === EMAIL_CHANGED_REASON;

// The server owns this URL's shape; the page answers whatever it carries.
const OAUTH_STATE_LOST_PARAMS = new URL(OAUTH_STATE_LOST_PAGE, 'http://n')
  .searchParams;

export const isOAuthStateLost = (query: NextRouter['query']) =>
  [...OAUTH_STATE_LOST_PARAMS].every(([key, value]) => query[key] === value);
