import { CustomError } from '../error-class';
import { HTTP_STATUS } from '../http-status';
import { MSG_CUSTOM_ROLE_PREFIX_FORBIDDEN } from '../messages/permissions';
import { CUSTOM_ROLE_VALUE } from './constants';

/** The back-end's `chk_custom_prefix_scope` ties this prefix to the custom scope. */
export const CUSTOM_ROLE_NAME_PREFIX = `${CUSTOM_ROLE_VALUE}-`;

/** The custom prefix names the roles `createCustomRole` mints. */
export function assertStandardRoleName(roleName: string): void {
  if (roleName.toLowerCase().startsWith(CUSTOM_ROLE_NAME_PREFIX))
    throw new CustomError(
      MSG_CUSTOM_ROLE_PREFIX_FORBIDDEN(CUSTOM_ROLE_NAME_PREFIX),
      HTTP_STATUS.BAD_REQUEST
    );
}
