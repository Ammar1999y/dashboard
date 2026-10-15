## 1. [Medium] Open upstream: two Bun 1.4.3 SQL client bugs, mitigated here but not fixed

Both reproduce on the installed Bun (1.4.3, Windows). Neither has been tried on Linux, the deployment's platform: no Docker or WSL distribution was available. Neither has been reported upstream, and a web search found no existing report.

### a. A request can stall after its row lock wait

**Status:** CONFIRMED 2026-10-15, in one of 10 full integration runs with a real lock holder in place of the spy in `tests/integration/oauth-reauthentication.test.ts`.

**What happens:**

- `lockUser` finished after a 1.47 s wait, then the backend sat `idle in transaction`. The next statement never came, and the request never answered.
- After the backend was terminated, its client socket stayed open with no TCP connection behind it. Bun never noticed.
- It did not reproduce in 250 looped real lock waits, or in 2380 waits from a standalone stress probe through the app's own `db`, `withTransaction` and `lockUser`. The root cause is not verified.

**Mitigated:** `db/index.ts` sets `idle_in_transaction_session_timeout` to 60 s on the application pool. PostgreSQL then ends such a session and frees the user's row lock, which the stall otherwise held until the process restarted.

- Confirmed in each connection's startup packet on the real server.
- Every integration configuration passed with 60 s, 10 s and 5 s.
- The longest legitimate idle gap measured is the Argon2 check inside the sign-in transaction: 0.6 s on an idle host, up to 3.1 s under heavy load.

**Still open:** the stalled request itself never answers. Whether its pool slot is ever returned is not verified.

### b. The pool can wedge for good after connections die while it reconnects

**Status:** CONFIRMED 2026-10-15 with plain `Bun.SQL` (11 of 18 storm runs) and on the real server.

**What happens:**

- Terminating the pool's backends during its own reconnect, as a PostgreSQL restart or failover would, can leave the pool so that every query fails at once, for good.
- The error is a plain `Error` ("connection must be a PostgresSQLConnection"), not one of Bun's `SQL` errors.
- No new backend is ever opened.
- `close()`, `timeout: 0` included, never resolves.
- Isolated terminations do not cause it. All 375 errors from single terminations were `SQL.PostgresError`, and the pool recovered every time.

**Mitigated:**

- `applicationPoolUsable()` in `db/index.ts` runs a single-flight `select 1` on the application pool. A rejection that is not a `SQL.SQLError` counts as wedged; a slow or busy pool does not.
- Readiness reports it as `checks.postgres: false` with a 503.
- The watchdog in `lib/pool-watchdog.ts`, wired in `server.ts`, checks every 30 s, looks again 5 s later, then shuts down with exit code 1. `closeDatabase` leaves a wedged pool unclosed.
- On the real server: 6 wedges, each ending in exit 1. After the close fix, wedge to exit took 23 s and 28 s with a clean shutdown; before it, 144–156 s on the forced-exit timer. There was no false trigger from isolated or tick-timed terminations, or from storms that did not wedge.
- Recovery relies on the container restart policy restarting a process that exits. Coolify applies `unless-stopped`; `reports/coolify-deployment.md` §7 records the dependency.

**Still open:** requests fail with 500 from the wedge until the exit, up to about 35 s.

**Fix:**

- Report both to Bun, with the reproductions:
  - (b) a plain `Bun.SQL` pool, 8 query loops, every backend terminated every 40 ms for 5 s;
  - (a) the real-lock variant of the oauth re-authentication test, in full integration runs.
- Re-run both reproductions on every Bun upgrade, and on Linux before the first production deploy.
