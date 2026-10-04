import type { BetterAuthOptions } from 'better-auth';

import { eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';
import { APIError } from 'better-auth/api';

import {
  REQUIRE_EMAIL_VERIFICATION,
  REQUIRE_PHONE_VERIFICATION,
} from '@app/shared/config';
import {
  EMAIL_NOT_VERIFIED_CODE,
  PHONE_NOT_VERIFIED_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_EMAIL_NOT_VERIFIED,
  MSG_INVALID_CREDENTIALS,
  MSG_PHONE_NOT_VERIFIED,
} from '@app/shared/messages/auth';
import { sanitizePermissions } from '@app/shared/permissions/matrix';
import { validID } from '@app/shared/utils';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';

import { auditLog, boundedAuditMeta, boundedUserAgent } from '@/lib/audit';

import { logSanitized } from '@/utils/log';

import { authError } from '../errors';
import { authDatabase } from '../transaction';
import { roleAllowsLogin } from '../user-eligibility';
import { revokeSessionArtifacts } from './rotation';

const SESSION_METHOD_BY_PATH: Readonly<Record<string, string>> = {
  '/sign-in/email': 'password',
  '/passwordless/verify': 'passwordless',
  '/oauth/google/callback': 'google',
  // The first factor is not knowable from these paths; the chain is on
  // `completeTwoFactorChallenge`'s completion event.
  '/two-factor/verify-totp': 'two_factor',
  '/two-factor/verify-backup-code': 'two_factor',
  '/two-factor/otp/verify': 'two_factor',
  '/two-factor/passkey/verify': 'two_factor',
};

export const sessionDatabaseHooks = {
  create: {
    // Fail-closed: any error here must block session creation.
    before: async (session) => {
      const userId = validID(session.userId);
      if (!userId)
        throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);

      const userData = await authDatabase().query.users.findFirst({
        where: (users, { eq, and, isNull }) =>
          and(eq(users.id, userId), isNull(users.deletedAt)),
        columns: {
          isActive: true,
          roleId: true,
          emailVerified: true,
          phoneNumberVerified: true,
        },
        with: {
          role: {
            columns: {
              id: true,
              roleName: true,
              scope: true,
              isActive: true,
            },
            with: {
              rolePermissions: {
                columns: { pageName: true, permissions: true },
              },
            },
          },
        },
      });

      if (!userData || !userData.isActive || !roleAllowsLogin(userData.role)) {
        throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
      }

      // After the first factor, so the distinct code leaks nothing; the
      // front-end keys on it. Inert while no OTP channel can verify the contact:
      // enabling one makes every unverified user verify at their next login.
      if (
        REQUIRE_EMAIL_VERIFICATION &&
        EMAIL_OTP_AVAILABLE &&
        !userData.emailVerified
      ) {
        throw new APIError(HTTP_STATUS.FORBIDDEN, {
          message: MSG_EMAIL_NOT_VERIFIED,
          code: EMAIL_NOT_VERIFIED_CODE,
        });
      }

      if (
        REQUIRE_PHONE_VERIFICATION &&
        PHONE_OTP_AVAILABLE &&
        !userData.phoneNumberVerified
      ) {
        throw new APIError(HTTP_STATUS.FORBIDDEN, {
          message: MSG_PHONE_NOT_VERIFIED,
          code: PHONE_NOT_VERIFIED_CODE,
        });
      }

      // Better Auth copies the header verbatim.
      const userAgent = boundedUserAgent(session.userAgent);

      if (!userData.roleId || !userData.role) {
        return {
          data: {
            ...session,
            userAgent,
            metadata: {},
          },
        };
      }

      return {
        data: {
          ...session,
          userAgent,
          metadata: {
            roleId: userData.roleId,
            roleName: userData.role.roleName,
            roleScope: userData.role.scope,
            permissions: sanitizePermissions(userData.role.rolePermissions),
          },
        },
      };
    },
    /**
     * The one place `loginSuccess` is written. Best-effort: the session
     * already exists. The method label is not the factor chain — a
     * first-factor session is logged before a challenge withdraws it.
     */
    after: async (session, context) => {
      try {
        const userId = validID(session.userId);
        if (!userId) return;

        const [user] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        // `audit_logs.user_email` is NOT NULL.
        if (!user) return;

        const path = context?.path ?? null;
        await withTransaction((tx) =>
          auditLog(tx, {
            userId,
            userEmail: user.email,
            action: 'INSERT',
            tableName: 'sessions',
            recordId: session.id,
            oldData: null,
            newData: {
              loginSuccess: true,
              method: SESSION_METHOD_BY_PATH[path ?? ''] ?? 'unknown',
              authPath: path,
            },
            meta: boundedAuditMeta(
              session.ipAddress ?? null,
              session.userAgent,
              path ?? 'session.create'
            ),
          })
        );
      } catch (error) {
        logSanitized('error', { msg: 'session.loginAudit.failed', error });
      }
    },
  },
  delete: {
    /**
     * Every library-side delete fires this once per row, so it is the one
     * boundary for `revokeSessionArtifacts`. Best-effort: it runs after the
     * library committed, the rows expire on their own, and a session id is
     * never reused.
     */
    after: async (session) => {
      try {
        await revokeSessionArtifacts(authDatabase(), [session.id]);
      } catch (error) {
        logSanitized('error', { msg: 'session.artifactRevoke.failed', error });
      }
    },
  },
} satisfies NonNullable<
  NonNullable<BetterAuthOptions['databaseHooks']>['session']
>;
