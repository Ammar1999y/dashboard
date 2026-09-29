## Target

- **Area:** <!-- name the boundary, e.g. forms: RHF setup, input components, validation schemas, submit and error handling -->

## Rules

- Follow `@CLAUDE.md` and `@.claude/skills/frontend/SKILL.md`. They override the existing code. Any file you change ends fully compliant, not only the lines you change. Nothing stays as-is just because it exists.
- Within the area, no limits on the means: rename, move, merge, split, delete, or restructure anything to reach the best shape within these guidelines. Nothing stays as-is just because it exists.
- Change behavior only to fix a bug or where the reference handles the same case better.
- Outside the area, change only what the area's changes require.

## Approach

- Map the area fully, before changing it: every site, consumer, and variant of each pattern, and how the pieces fit together. Never judge from one file.
- Converge each concern on one implementation.

## Improve

- Follow `@CLAUDE.md` and `@.claude/skills/frontend/SKILL.md`. They override the existing code. Any file you change ends fully compliant, not only the lines you change. Nothing stays as-is just because it exists.
- Map the area fully, before changing it: every site, consumer, and variant of each pattern, and how the pieces fit together. Never judge from one file.
- Bugs and latent risks (races, stale or invalid state, unhandled errors and edge cases, broken contracts) → fix, and sweep each one's class.
- Repeated patterns → shared wrapper, hook, helper, or component.
- Repeated props/config → sensible defaults.
- Boilerplate → centralized.
- Anything else that makes future work in this area simpler or safer.
- Abstract only when it removes real duplication. No speculative layers.
