/**
 * Contract mismatches the response check answered 500 for, held until the test
 * preload fails the test that caused them: a test that ignores the response
 * would otherwise pass on the 500.
 *
 * ⚠️ No imports: the base preload loads this before the environment the
 * application reads at load is set up.
 */
const pending: string[] = [];

export function recordResponseMismatch(problem: string): void {
  pending.push(problem);
}

/** The mismatches recorded since the last call. */
export function takeResponseMismatches(): string[] {
  return pending.splice(0);
}
