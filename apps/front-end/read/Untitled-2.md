https://play.google.com/store/apps/details?id=sa.suwa.athar

## Target

- **Area:** <!-- name the boundary, e.g. forms: RHF setup, input components, validation schemas, submit and error handling -->
- **Goal:** <!-- what "done" looks like -->
- **Reference:** <!-- optional: path/project to learn patterns from -->
- **Exclude:** <!-- optional: files, folders, or concerns to leave untouched, e.g. apps/back-end, the media upload form, anything that changes the API contract -->

## Rules

- Follow `@CLAUDE.md` and `@.claude/skills/frontend/SKILL.md`. They override the existing code and the reference. Any file you change ends fully compliant, not only the lines you change.
- Within the area, no limits on the means: rename, move, merge, split, delete, or restructure anything to reach the best shape within these guidelines. Nothing stays as-is just because it exists.
- Preserve what the project does, not how it does it. Project-specific features stay even when the reference lacks them, but their code is refactored, moved, and improved like everything else.
- Change behavior only to fix a bug or where the reference handles the same case better.
- Outside the area, change only what the area's changes require.
- Never change anything under Exclude, even when the area's changes would require it. Report the need instead.

## Approach

- Map the area fully, in both the project and the reference, before changing it: every site, consumer, and variant of each pattern, and how the reference's pieces fit together. Never judge from one file.
- If a reference is given, check it before writing each part and before introducing anything new: a helper, hook, component, library, or API call. It has likely solved the same problem and been exercised more than this project, so its answer is the default: file layout, structure, naming, style, abstractions, and how it uses each API, not only the overall pattern. Study it in more than one place and understand why it is built that way. It is evidence, not authority: deviate where it has a flaw, doesn't fit this project, or a better way reaches the same idea, and state why.
- Converge each concern on one implementation.

## Improve

- Bugs and latent risks (races, stale or invalid state, unhandled errors and edge cases, broken contracts) → fix, and sweep each one's class.
- Repeated patterns → shared wrapper, hook, helper, or component.
- Repeated props/config → sensible defaults.
- Boilerplate → centralized.
- Anything else that makes future work in this area simpler or safer.
- Abstract only when it removes real duplication. No speculative layers.
