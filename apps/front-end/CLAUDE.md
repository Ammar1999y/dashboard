# CLAUDE.md

Applies to every response and to the code already here. Before finishing, confirm silently that the response meets it.

Existing code is a reference, not an authority. Follow it where it meets this standard. Where it conflicts, fix it in the code you are changing and report it everywhere else.

React and Next.js work also follows `.claude/skills/frontend/SKILL.md`.

## Baseline

- **English** for code, identifiers, comments and replies. User-facing copy stays in the product language.
- **State assumptions, then act.** Name them briefly for non-trivial work. Ask only when the request is genuinely ambiguous.
- **Flag uncertainty** ("not verified: X"). A guess presented as a finding is worse than no answer.

## Engineering standard

Protect component boundaries, data contracts and render behaviour (SSR, hydration, re-renders).

Priorities, highest first: **correctness → contract compatibility → maintainability → measured performance.**

The frontend skill's render rules are the default way to write components, not optimizations. Anything beyond them (rewrites, extra memo layers, new lazy boundaries, caching) needs a measurement, not a hunch.

## Scope

- **Map before a non-trivial change.** List every site, consumer and variant of the pattern and how they connect. Never judge from one file.
- **An area includes its ecosystem:** the files that exist only to serve it (types, stores, `lib` helpers, column definitions, mocks), even outside its folder. Outside that, change only what the change requires.

## Fix discipline

A reported defect is one **sample of a class**.

- **Sweep the class within scope, not only the instance.** Check callers and consumers, sibling components and routes, mappers and serializers, SSR and client paths, feature modes, mocks and error paths. Search the underlying operation, not only the edited symbol. Fix at the shared boundary where possible, and list what you deferred.
- **Treat latent risks in scope as defects,** and report those outside it: races and out-of-order responses, stale closures, stale or impossible state, hydration mismatches, missing effect cleanup, unhandled rejections, missing loading/empty/error states, unhandled edge cases, broken contracts.
- **Fail clearly.** No fallback that hides a failed operation, such as substituting the unprocessed original. A default for an absent optional value is fine. Raise a typed error, show a clear message, and branch on the error type, never on its text.
- **Never narrow an existing contract to fix an unrelated bug.**

## Consistency

One implementation per concern. The codebase should read as though one person wrote it: convergence beats a slightly better variant.

- **Reuse before writing.** Search the app and `@app/shared` for an existing helper, hook, component, constant or message. Search by value, not only by name. Reimplementing what exists is a defect even when it works; if it almost fits, extend it.
- **Follow the dominant pattern.** Before writing a kind of code the app already has, find how it is written across the app, not only next door, and match it. Where patterns compete, adopt the dominant one and note the divergence.
- **Centralize real duplication.** Repeated logic becomes a shared hook, helper or component. Repeated props or config become defaults. Boilerplate lives in one place. Abstract only duplication that exists now, with no speculative layers.

## Verification

`bun run lint` (types, ESLint) proves that shapes line up, nothing more.

- **Verify behaviour end to end,** not just the function you edited. Trace the feature through the neighbouring layers.
- **Chase every reference.** After changing a function, type, prop or export, check each caller for reliance on the old contract.
- **Run the smallest check that proves it** when reasoning is not enough: a case under `bun test tests`, dont run or test the app for UI. Report the command and its result, whether temporary test code remains, and every check you could not run.

## Before claiming a defect

Never call something missing, broken or unsupported based on memory or bundle greps.

1. Check the installed version.
2. Read its source and local types.
3. Read the docs for that version. For Next.js, use `node_modules/next/dist/docs/` at the repo root, not training data.
4. Search the web before giving up.

## Types

- **Earn every invented type.** Import a library's exported type. Otherwise treat the value as `unknown` and validate it at runtime. An unchecked `as` on an assumed shape is `any` in disguise, and it breaks silently when the source changes.
- **`any` is occasionally correct** where a precise type is the wrong answer. Suppress it with the narrowest `eslint-disable-next-line`.

## Comments

Default: none. Before writing one, ask what is lost without it; if nothing, don't write it. Its reader is a senior engineer with the file open.

- **Never:** restating code, signatures or types; change history or notes on the edit (those go in the reply); versions or constant values; language or framework behaviour; section banners.
- **Only:** non-local coupling, an external constraint that forced the shape, a deliberate choice that looks wrong, an invariant a future edit could silently break, an instruction to the next person.
- **Length scales with the cost of ignoring it.** A trap gets a clause; nothing gets a paragraph.
