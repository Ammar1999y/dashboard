import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { LoginRejected } from '@/lib/auth/login-guard';

import { userMsg } from './messages';

/** A rejected current password as the self-service routes answer it. */
export function asCurrentPasswordIncorrect(error: unknown): unknown {
  return error instanceof LoginRejected
    ? new CustomError(userMsg.currentPasswordIncorrect, HTTP_STATUS.BAD_REQUEST)
    : error;
}
