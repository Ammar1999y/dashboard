@.claude/skills/frontend/SKILL.md
@.claude/skills/caveman/SKILL.md
@CLAUDE.md

Files above are standing instructions for this session.

---

**Session rule:** Do not create or spawn subagents — do all the work yourself.
This overrides the "3. Execution" section mentioned in `CLAUDE.md`.

---

## Target

- **Area:** <!-- name the boundary, e.g. forms: RHF setup, input components, validation schemas, submit and error handling -->
- **Usage is part of the area.** The code that uses the area (props, classes, handlers, wrappers, helper calls at each call site) is held to every rule here, the same as the area itself. Map every call site before changing anything.

## Rules

- Follow `@CLAUDE.md` and `@.claude/skills/frontend/SKILL.md`. They override the existing code. Files inside the area end fully compliant, not only the lines you change. At a call site, the code that uses the area ends fully compliant; the rest of that file is outside the area. Nothing stays as-is just because it exists.
- Within the area, no limits on the means: rename, move, merge, split, delete, or restructure anything to reach the best shape within these guidelines. Nothing stays as-is just because it exists.
- Change behavior only to fix a bug.
- Beyond the area and its usage, change only what the area's changes require.

## Approach

- Map the area fully, before changing it: every site, consumer, and variant of each pattern, and how the pieces fit together. Never judge from one file.
- Converge each concern on one implementation.

## Improve

- Follow `@CLAUDE.md` and `@.claude/skills/frontend/SKILL.md`. They override the existing code. Files inside the area end fully compliant, not only the lines you change. At a call site, the code that uses the area ends fully compliant; the rest of that file is outside the area. Nothing stays as-is just because it exists.
- Map the area fully, before changing it: every site, consumer, and variant of each pattern, and how the pieces fit together. Never judge from one file.
- Bugs and latent risks → fix, and sweep each one's class.
- Repeated patterns → shared wrapper, hook, helper, or component.
- Repeated props/config → sensible defaults.
- Boilerplate → centralized.
- Anything else that makes future work in this area simpler or safer.
- Abstract only when it removes real duplication. No speculative layers.
