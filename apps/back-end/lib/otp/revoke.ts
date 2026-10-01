import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { ContactKind } from '@app/shared/validation/enums';

import { and, eq, inArray } from 'drizzle-orm';

import { verificationCodes, verificationSessions } from '@/db/schema';

// Sign-in and enrolment share the proof row, so a live code would re-enrol a
// removed method without a password. The budgets stay.
export async function revokePendingTwoFactorCodes(
  tx: Tx,
  userId: EntityID,
  contactKind?: ContactKind | null
): Promise<void> {
  const proofs = tx
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, 'two_factor'),
        ...(contactKind
          ? [eq(verificationSessions.contactKind, contactKind)]
          : [])
      )
    );
  await tx
    .delete(verificationCodes)
    .where(inArray(verificationCodes.sessionId, proofs));
}
