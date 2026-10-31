# CLAUDE.md

Applies to every response and to the code already here. Before finishing, confirm silently that the response meets it.

Existing code is a reference, not an authority. Follow it where it meets this standard. Where it conflicts, fix it in the code you are changing and report it everywhere else.

## Baseline

- **English** for code, identifiers, comments and replies. User-facing copy stays in the product language.
- **State assumptions, then act.** Name them briefly for non-trivial work. Ask only when the request is genuinely ambiguous.
- **Flag uncertainty** ("not verified: X"). A guess presented as a finding is worse than no answer.

## Engineering standard

Treat every reachable endpoint as exposed to hostile input, but calibrate scale, availability and performance work to the actual threat model and to evidence. Security invariants do not depend on traffic volume; rewrites and speculative performance work do.

Protect API contracts, the schema and its migrations, and auth and session invariants.

A migration must leave the previous release working: `db:migrate` runs before the container swap, while the old release still serves. Drop or rename only in a release after the code stops using the old shape.

Priorities, highest first: **security → correctness → contract compatibility → maintainability → measured performance.**

## Scope

- **Map before a non-trivial change.** List every site, consumer and variant of the pattern and how they connect. Never judge from one file.
- **An area includes its ecosystem:** the files that exist only to serve it (contract entry and field docs in `@app/shared`, binding, schema and validation, `lib` module, messages, migrations, tests), even outside its folder. Outside that, change only what the change requires.

## Fix discipline

A reported defect is one **sample of a class**.

- **Sweep the class within scope, not only the instance.** Check callers and consumers, sibling routes and channels, parsers and serializers, feature modes and error paths. Search the underlying operation, not only the edited symbol. Fix at the shared boundary where possible, and list what you deferred.
- **Treat latent risks in scope as defects,** and report those outside it: check-then-write races, multi-step writes outside a transaction, unbounded input or result sets, outbound calls without a timeout, error responses that leak internals or enumerate accounts, a sibling route missing the check its twin has, unhandled rejections, broken contracts, a grant that survives a role downgrade, list/detail/download paths to one object that authorize differently, a cache hit that skips an auth, quota or rate-limit check, a pool query awaited inside a caller's transaction, a handler that assumes state another handler creates.
- **Fail clearly.** No fallback that hides a failed operation. A default for an absent optional value is fine. Raise a typed error and branch on its type or code, never on its message text.
- **Never narrow an existing contract to fix an unrelated bug.**

## Consistency

One implementation per concern. The codebase should read as though one person wrote it: convergence beats a slightly better variant.

- **Reuse before writing.** Search the app and `@app/shared` for an existing helper, constant, message or error. Search by value, not only by name. Reimplementing what exists is a defect even when it works; if it almost fits, extend it.
- **Follow the dominant pattern.** Before writing a kind of code the app already has, find how it is written across the app, not only next door, and match it. Where patterns compete, adopt the dominant one and note the divergence.
- **Centralize real duplication.** Repeated logic becomes a shared helper. Repeated options or config become defaults. Boilerplate lives in one place. Abstract only duplication that exists now, with no speculative layers.
- **Derive, don't mirror.** A list or table that restates another (allowed paths, forced fields, a published shape) is built from its source, or a test fails when the two drift.
- **Every endpoint is one contract entry in `@app/shared/api`, served through `bind()`,** or, for a Better Auth plugin endpoint, built from its entry with `pluginEndpoint()`. Nothing registers a route by hand. Schemas are compiled only at registration, never through the global `zod/compile`: it would compile Better Auth's schemas too. Wire bodies come only from core's body builders, so a format change stays one function per body kind.
- **Use Elysia features where they improve the code, and keep their calls in `app.ts` and `server/elysia/`.** Easing a future port is not a reason to avoid one.

## Verification

`bun run lint` (types, ESLint) proves that shapes line up, nothing more.

- **Verify behaviour end to end,** not just the function you edited. Trace the feature through the neighbouring layers.
- **Chase every reference.** After changing a function, type or export, check each caller for reliance on the old contract.
- **Run the smallest check that proves it** when reasoning is not enough. Report the command and its result, whether temporary test code remains, and every check you could not run.
- **A rejection test also asserts that durable state did not change.** A status code alone passes when the write happened anyway.

## Before claiming a defect

Never call something missing, broken or unsupported based on memory or bundle greps. The same applies before new code relies on how a library behaves (a default, a timeout, what it stores or refuses).

1. Check the installed version.
2. Read its source and local types.
3. Read the docs for that version: next.elysiajs.com for Elysia 2 (index in `docs/elysia-llms.md`, API reference in `docs/elysia-llms-references.md`, full live index at `https://next.elysiajs.com/llms.txt`); elysiajs.com is 1.4. Drizzle is 0.x (`relations()`, relational queries v1, journal-based migrations), while orm.drizzle.team now documents 1.0. Bun's docs for the installed types are in `node_modules/bun-types/docs/`. The installed package wins where they disagree.
4. Search the web before giving up.

## Types

- **Earn every invented type.** Import a library's exported type. Otherwise treat the value as `unknown` and validate it at runtime. An unchecked `as` on an assumed shape is `any` in disguise, and it breaks silently when the source changes.
- **`any` is occasionally correct** where a precise type is the wrong answer. Suppress it with the narrowest `eslint-disable-next-line`.

## Comments

Default: none. Before writing one, ask what is lost without it; if nothing, don't write it. Its reader is a senior engineer with the file open.

- **Never:** restating code, signatures or types; change history or notes on the edit (those go in the reply); versions or constant values; language or framework behaviour; section banners.
- **Only:** non-local coupling, an external constraint that forced the shape, a deliberate choice that looks wrong, an invariant a future edit could silently break, an instruction to the next person.
- **Length scales with the cost of ignoring it.** A trap gets a clause; nothing gets a paragraph.

## Context

This repository is the **starter kit** for most of my upcoming projects. No production data yet, but it will be relied on heavily going forward.

It deploys to a **private VPS running Coolify**; server-side steps live in @reports/coolify-deployment.md.

## Routing

Some work belongs on the server, VPS, Coolify, proxy or Cloudflare, not in application code. Route every server-side requirement to `@reports/coolify-deployment.md`:

- **When to add:** only when a task needs future server-side configuration to work or to perform well.
- **What goes there:** server configuration, deployment, and operational requirements and steps.
- **Reading policy:** **do not read it proactively.** Open it only when you are about to add a requirement and need to check whether it is already there.
