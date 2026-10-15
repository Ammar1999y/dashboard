import type { ContactKind } from '@app/shared/validation/enums';

import { generateBackupCodes, startTotp } from '@/lib/account/two-factor';
import { createDialog } from '@/lib/dialogs';

// None has a `urlId`: each carries data, or must not outlive the page it ends.

/** An authenticator's enrolment URI, which the code from the app confirms. */
export const totpDialog = createDialog<{ totpURI: string }>();

/** A code to the account's email or phone, and the code that comes back. */
export const otpDialog = createDialog<{ kind: ContactKind }>();

/** The one showing of a new set of backup codes. */
export const backupCodesDialog = createDialog<{
  codes: readonly string[];
  setId: string;
}>();

export const passkeyDialog = createDialog();

/** Starts an enrolment and opens the dialog that finishes it, once the server has a secret to show. */
export async function beginTotpEnrolment() {
  totpDialog.open({ totpURI: await startTotp() });
}

/** Generates a set and shows it: nothing keeps the codes to show them again. */
export async function showNewBackupCodes() {
  const { backupCodes, setId } = await generateBackupCodes();
  backupCodesDialog.open({ codes: backupCodes, setId });
}
