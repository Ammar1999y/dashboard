import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { userMsg } from '@app/shared/messages/users';

import { LoginRejected } from '@/lib/auth/login-guard';

/** A rejected current password as the self-service routes answer it. */
export function asCurrentPasswordIncorrect(error: unknown): unknown {
  return error instanceof LoginRejected
    ? new CustomError(userMsg.currentPasswordIncorrect, HTTP_STATUS.BAD_REQUEST)
    : error;
}
