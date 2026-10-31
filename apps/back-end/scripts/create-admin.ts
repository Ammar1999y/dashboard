/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * `bun run create-admin --email=<address> --name=<name> [--phone=<number>]`
 *
 * Creates the first administrator: a `system` role holding every permission,
 * as `/api/dev/sign-up` does in development. It refuses once any live user
 * holds a `system` role. The password is generated and printed once to stdout;
 * it is never read from arguments or the environment, never logged, and never
 * stored anywhere but as its hash.
 *
 * Exit codes: 0 created, 2 invalid input, 3 an administrator already exists,
 * 1 anything else (configuration, database). 2 and 3 write nothing; a 1 from a
 * dropped connection during COMMIT may follow a committed account.
 */
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

import { REQUIRE_PHONE_VERIFICATION } from '@app/shared/config';
import { PHONE_OTP_AVAILABLE } from '@app/shared/validation/otp';
import {
  EMAIL_PROVIDER_DOMAINS,
  passwordSchema,
} from '@app/shared/validation/rules';
import { createAdminSchema } from '@app/shared/validation/users';

const USAGE =
  'usage: bun run create-admin --email=<address> --name=<name> [--phone=<number>]';

const EXIT_FAILED = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_ADMINISTRATOR_EXISTS = 3;

class AdministratorExistsError extends Error {
  constructor() {
    super('an administrator already exists');
    this.name = 'AdministratorExistsError';
  }
}

function refuse(code: number, line: string): never {
  console.error(line);
  process.exit(code);
}

/** Printable ASCII with no quote, backslash or space, so it survives a copy from any terminal. */
const PASSWORD_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_!@#%^*+=?';
const PASSWORD_LENGTH = 24;

function generatePassword(): string {
  for (;;) {
    let password = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++)
      password += PASSWORD_ALPHABET.charAt(
        crypto.randomInt(PASSWORD_ALPHABET.length)
      );
    if (passwordSchema.safeParse(password).success) return password;
  }
}

function readInput() {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        phone: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    refuse(
      EXIT_INVALID_INPUT,
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`
    );
  }

  if (values.email === undefined || values.name === undefined)
    refuse(EXIT_INVALID_INPUT, USAGE);

  const parsed = createAdminSchema.safeParse({
    email: values.email,
    name: values.name,
    phoneNumber: values.phone,
  });
  // English for the operator; the issue messages are the product's copy.
  if (!parsed.success) {
    const lines = new Set(
      parsed.error.issues.map(({ path, code }) => {
        const field = path[0];
        return field === 'email'
          ? `invalid --email (${code}; accepted domains: ${EMAIL_PROVIDER_DOMAINS.join(', ')})`
          : `invalid --${field === 'phoneNumber' ? 'phone' : String(field)} (${code})`;
      })
    );
    refuse(EXIT_INVALID_INPUT, [...lines].join('\n'));
  }

  // The sign-in gate would refuse an unverified phone, and an account with no
  // phone has nothing to verify.
  if (
    REQUIRE_PHONE_VERIFICATION &&
    PHONE_OTP_AVAILABLE &&
    !parsed.data.phoneNumber
  )
    refuse(
      EXIT_INVALID_INPUT,
      'invalid --phone (required: this deployment requires a verified phone at sign-in)'
    );

  return parsed.data;
}

const input = readInput();

// After the input check, so a typo is reported without the server's
// configuration; the imports below refuse to load on a missing variable.
let modules;
try {
  modules = await Promise.all([
    import('@/db'),
    import('@/db/errors'),
    import('@/lib/audit'),
    import('@/lib/auth/password/hash'),
    import('@/lib/users/system-user'),
    import('@/utils/log'),
  ]);
} catch (error) {
  refuse(
    EXIT_FAILED,
    `configuration error: ${error instanceof Error ? error.message : String(error)}`
  );
}
const [
  { closeDatabase, withTransaction },
  { getConstraintName, isUniqueViolation },
  { auditLog, boundedAuditMeta },
  { hashPassword },
  { administratorExists, insertSystemUser, lockFirstAdministrator },
  { errorClassOf, logSanitized },
] = modules;

const password = generatePassword();

let exitCode = EXIT_FAILED;
try {
  const passwordHash = await hashPassword(password);

  const userId = await withTransaction(
    async (tx) => {
      await lockFirstAdministrator(tx);
      if (await administratorExists(tx)) throw new AdministratorExistsError();

      const created = await insertSystemUser(tx, { ...input, passwordHash });

      // No user acted, so the row names the account it created; `actor` and the
      // path say who did.
      await auditLog(tx, {
        userId: created.userId,
        userEmail: input.email,
        action: 'INSERT',
        tableName: 'users',
        recordId: created.userId,
        newData: {
          name: input.name,
          email: input.email,
          roleId: created.roleId,
          isActive: true,
          ...(input.phoneNumber && { phoneNumber: input.phoneNumber }),
          actor: 'bootstrap',
        },
        meta: boundedAuditMeta(null, null, 'internal/create-admin'),
      });

      return created.userId;
    },
    // ⚠️ The check has to see what a run ahead of it committed while it waited
    // for the lock; a repeatable-read snapshot is taken before the wait.
    { isolationLevel: 'read committed' }
  );

  console.log(
    [
      'Administrator created.',
      `  id:       ${userId}`,
      `  email:    ${input.email}`,
      `  password: ${password}`,
      '',
      'The password is shown once and is not stored. Sign in with it, then change it.',
    ].join('\n')
  );
  exitCode = 0;
} catch (error) {
  if (error instanceof AdministratorExistsError) {
    console.error('An administrator already exists. Nothing was changed.');
    exitCode = EXIT_ADMINISTRATOR_EXISTS;
  } else if (isUniqueViolation(error)) {
    const constraint = getConstraintName(error);
    console.error(
      constraint === 'ux_users_phone_number'
        ? 'A user with this phone number already exists. Nothing was changed.'
        : constraint === 'ux_users_email'
          ? 'A user with this email already exists. Nothing was changed.'
          : `Unique constraint ${constraint || '(unnamed)'} refused the insert. Nothing was changed.`
    );
    exitCode = EXIT_INVALID_INPUT;
  } else {
    // The driver's message can quote the statement's parameters, the hash among them.
    logSanitized('error', {
      msg: 'createAdmin.failed',
      errorClass: errorClassOf(error),
      causeClass:
        error instanceof Error && error.cause !== undefined
          ? errorClassOf(error.cause)
          : undefined,
      constraint: getConstraintName(error) || undefined,
    });
    // A failure after COMMIT reached the server leaves the account created.
    console.error(
      'Creating the administrator failed. If the database committed before the failure, the account exists: a rerun then exits 3.'
    );
  }
} finally {
  await closeDatabase();
}
process.exit(exitCode);
