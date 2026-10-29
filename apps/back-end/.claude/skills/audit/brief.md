# Audit brief

Paths are relative to `apps/back-end`. Read `CLAUDE.md` before anything else and audit the code against its code-facing standards; its agent-behaviour rules govern you, not the code. You return evidence; the orchestrator decides what is a finding and writes the report.

## Scope

- By default the whole codebase, not a diff: this workspace plus the `packages/shared` sources it imports. Ignore the root directories `build/`, `bench/`, `coverage/`, `data/`.
- Read every file in your area in full, not a sample, and judge the whole file, not only the code that looked suspicious. Your area includes its usage: the code at each call site that uses it.
- `tests/` is evidence, not an audit target: no findings about test code itself. Missing coverage is a finding: risky logic with no test that would fail if it broke, including a test that exists but would still pass.
- Lenses, not boundaries — report anything material you can prove: security, privacy, correctness, contracts, validation, types, races, stale or invalid state, edge cases, transactions, data integrity, lifecycle, resources, error handling, queries, indexes, performance, architecture, layering and import direction, consistency, duplication, boilerplate, dead code, naming, tooling, config, CI, deployment, dependencies.
- Latent risks count when the trigger is provable, not only live bugs.
- The published OpenAPI document is the contract with the front-end, which is built in parallel. "The front-end doesn't handle this" is not a finding; a behaviour change is one only when OpenAPI doesn't describe it.
- The entries the orchestrator pasted from `reports/should-ignore.md`, `TODO.md` and `reports/performance-audit.md` are the owner's decisions and deferrals. Skip them unless new evidence changes their impact, disproves their reasoning, or reveals a distinct problem.

## Nothing is right because it exists

Existing code proves nothing about itself: not its comments, not how often it repeats, not that its tests pass. When the dominant pattern is itself wrong, that is one suspect covering every site, and its alternative must beat it by more than a little: `CLAUDE.md` puts convergence above a slightly better variant. Judge each area at three levels:

- **Defects:** what is wrong now, or provably reachable.
- **Approach:** whether the design is the right one. Does the code need to exist at all? Does an existing helper, Elysia, Better Auth, Drizzle, zod, Bun, Postgres (a constraint or one statement in place of app code) or an installed dependency already do it, on the installed version? Does a dependency do what Bun or a few lines would? Would another design close a class of bugs, remove a duplicated concern or cut a measured cost? Name the alternative and what it costs: contract, schema and migration, call sites, risk.
- **Shape:** whether the area has its best form: names; location and layering, including the shared boundary, decided by what the code is rather than by who imports it today; files that mix unrelated jobs; near-copies that must change together; layers that only pass calls through; options and config nobody sets. The remedy may be to rename, move, merge, split, delete or restructure. Split by job, never by length. Call sites that re-validate, cast, adapt or work around an interface are evidence against it.

An improvement (a better approach or shape, a shared helper, a sensible default, centralized boilerplate) is a suspect only when it removes something real: duplication that exists now, a risk, code or concepts the behaviour does not need, or a measured cost. No speculative layers, no taste. Simpler means fewer concepts and fewer places to change, not fewer characters. An alternative counts only if it keeps every behaviour callers rely on — validation, error handling, edge cases, the contract — checked on the installed version, not assumed.

## Performance

Report performance issues and opportunities, each backed by a count or measurement you produced: a probe, test or benchmark you ran, or a count derived from the code, such as queries per row or round trips per request.

- There is no production data yet. Judge a cost by how it grows (with rows, page size, filters, upload size, concurrent callers) up to the bounds the contracts and limits admit.
- A cost that grows without bound, with data or with what a caller in the threat model sends, is a defect. A bounded cost that a change measurably cuts is an opportunity: what it costs now, what the change gains, and what the change costs.
- Prefer counts to timings: statements and transactions (`recordStatements()` in `tests/helpers/statements.ts`), round trips, connections, encodes. The dev box is shared with other sessions, so its timings are only relative to each other; say where a Linux figure would change the call.
- An index claim needs a plan on a realistic row count: on a near-empty test database the planner scans sequentially either way.

## Threat model

- Attackers, most likely first: an anonymous caller; a signed-in user with a low role; a holder of a role-management permission trying to escalate; a malicious uploaded file; a request that reaches the origin without passing Cloudflare.
- Trusted: the operator, the environment, Coolify, Postgres.
- Each security suspect names the attacker it assumes and what they gain beyond what their position already allows. No gain, no suspect.

## Evidence

- Verify each suspect across its end-to-end flow. Never judge a file in isolation; don't recurse into unrelated imports.
- Name the guard that should stop it and why it doesn't: the zod contract at `bind()`, database constraints, Better Auth's internals, the rate-limit layer, the caller. A comment or stated rationale is a claim to check, not a guard.
- Enumerate every path to the same operation or identity (sibling routes, Better Auth's own endpoints, batch, retry, error and migration paths) and compare their controls for equivalence, not just presence: the effective policy is the weakest of them.
- Treat each defect as a sample of its class: sweep every site with the same shape and list them all. The exact pattern must first match the known instance; then widen one element at a time (related identifiers, other manifestations of the same operation, data-type edge cases) until the matches turn to noise.
- A dead-code suspect needs a search of the whole repository, including tests, scripts, CI, config and string or dynamic references. Unreachable files and unused exports already fail `find:unused-files`, but its entries include the tests, so code only tests reach passes it; look there and below the export level.
- An area with no suspects is a valid result. Never pad: return what you checked instead.
- Uncertainty is not a finding. Resolve version-dependent behaviour per `CLAUDE.md` "Before claiming a defect", plus a focused reproduction when needed. Return what you could not resolve as a separate list, never as a suspect.
- Don't run full suites; they pass on CI. To check a point, run the existing test that covers it before writing anything new.

## Runtime targets

- Single process today; must move to Bun multi-process / multi-thread without redesign.
- Linux (Ubuntu 24.x) in production; Windows 10/11 for development only.
- Report only what provably breaks or diverges under several workers, or on the other platform. Not-yet-parallel code is not a finding; claims about Bun parallelism APIs meet `CLAUDE.md` "Before claiming a defect".

## Writes and reads

- You make no persistent change. This overrides `CLAUDE.md`'s allowance for retained test files.
- Verification may use `bun -e`, a REPL, targeted existing tests, read-only commands, and temporary files deleted before you finish.
- `reports/`: read only `should-ignore.md`, and `coolify-deployment.md` when a server/VPS/Coolify/proxy/Cloudflare suspect needs checking against it. Never edit either.
- `docs/`: read only files explicitly shared with you or referenced.

## Traps in this repo

- Bun loads `.env`, which holds live R2 and Upstash credentials. A probe that writes to either uses a `probe/` key prefix and deletes what it wrote; nothing else calls an external or paid service.
- Other sessions share the working tree. Name temporary files uniquely, never delete or overwrite a file you did not create, and treat a lint or `ENOENT` failure on someone else's `*-probe-*` file as theirs.
- `tests/helpers/run.ts` takes forwarded flags only as `--flag=value`; a separate value is read as a file filter.
- The integration, process and matrix tiers run with `NODE_ENV=development`, and captcha, dev routes, security headers and response checks branch on it. A behaviour claimed for production is checked under production's environment.
- A zod parse of a plain object strips unknown keys, so it proves nothing about conformance.
- Earlier layers answer before the guard under test. Without `cf-connecting-ip`, development puts every request in one loopback rate-limit bucket (429s) and production answers 503; captcha answers 403 whenever siteverify is unreachable.
- `app.handle()` skips the server layer. When headers, body limits or streaming matter, measure a real server response.

## Return

Unless your prompt asks for something else, for each suspect: whether it is a defect or an improvement; the claim; `file:line` and symbol, or the flow; evidence (the path traced, and any command with its output); for a defect, a concrete failure scenario, and for an improvement, what the code costs now and what the change gains; every site in its class; a remediation. A defect's remediation is the smallest change that fixes the whole class, preferably one that deletes code or reuses what exists, and it changes behaviour only to fix the defect. An improvement's is the alternative and what it costs, and for a shape change the target shape and every call site it reaches. Then the files you read in full, what you checked and found clean, and what you could not resolve, with what you tried.
