/**
 * `path-policy.ts` swaps the verified plaintext for a one-shot proof, and
 * `password.verify` accepts only proofs, so a plaintext reaching it fails
 * closed. A SET of hashes because a pepper rehash may land in between.
 * ⚠️ `path-policy.ts` must stay the only minter.
 */
import crypto from 'node:crypto';

import { PASSWORD_MAX } from '@app/shared/validation/constants';

/** Distinguishes a proof from a password in a log. Not a security boundary. */
const PROOF_PREFIX = 'pwproof_';

/** Constrained by the `PASSWORD_MAX` assertion at the bottom of this file. */
const PROOF_ENTROPY_BYTES = 96;

/** A proof only spans the `before` hook and the handler in the same request. */
const PROOF_TTL_MS = 60_000;

/** Swept on crossing rather than per mint, which would make a login burst quadratic. */
const SWEEP_THRESHOLD = 256;

interface PendingProof {
  readonly hashes: ReadonlySet<string>;
  readonly expiresAt: number;
}

// Process-local by design: hook and handler share one request in one process.
const pending = new Map<string, PendingProof>();

function sweepExpired(now: number): void {
  for (const [token, proof] of pending)
    if (proof.expiresAt <= now) pending.delete(token);
}

/** `hashes`: every value the account row could hold when the handler reads it. */
export function mintPasswordProof(hashes: readonly string[]): string {
  const accepted = hashes.filter((hash) => hash.length > 0);
  if (accepted.length === 0)
    throw new Error('mintPasswordProof requires at least one non-empty hash');

  const now = Date.now();
  if (pending.size >= SWEEP_THRESHOLD) sweepExpired(now);

  const token = `${PROOF_PREFIX}${crypto.randomBytes(PROOF_ENTROPY_BYTES).toString('base64url')}`;
  pending.set(token, {
    hashes: new Set(accepted),
    expiresAt: now + PROOF_TTL_MS,
  });
  return token;
}

/**
 * Deletes before deciding, so a proof is spent even when it did not match. No
 * constant-time compare, deliberately: a map lookup of CSPRNG output.
 */
export function consumePasswordProof(hash: string, candidate: string): boolean {
  const proof = pending.get(candidate);
  if (!proof) return false;
  pending.delete(candidate);
  return (
    proof.expiresAt > Date.now() && hash.length > 0 && proof.hashes.has(hash)
  );
}

/**
 * Longer than `PASSWORD_MAX`, so no inbound password surviving validation is a
 * proof. Also Better Auth's `maxPasswordLength`: the library measures the proof
 * the handler receives, and the inbound cap stays `PASSWORD_MAX` in the hook.
 */
export const PROOF_LENGTH =
  `${PROOF_PREFIX}${Buffer.alloc(PROOF_ENTROPY_BYTES).toString('base64url')}`
    .length;
if (PROOF_LENGTH <= PASSWORD_MAX)
  throw new Error(
    `password proof length (${PROOF_LENGTH}) must exceed PASSWORD_MAX (${PASSWORD_MAX}); ` +
      'raise PROOF_ENTROPY_BYTES so a proof can never be a valid password'
  );
