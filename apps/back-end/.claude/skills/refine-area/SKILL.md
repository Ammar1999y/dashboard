---
name: refine-area
description: Bring an area (default: the last commit's changes) and its call sites fully up to the app's CLAUDE.md. Run only when asked.
disable-model-invocation: true
argument-hint: "[area — default: last commit]"
---

## Target

- **Area:** $ARGUMENTS. If empty, the files changed in the last commit, plus their ecosystem.
- **Usage is part of the area.** The code that uses the area at each call site is held to the same rules. Map every call site before changing anything.

## Rules

- The CLAUDE.md of each app the area touches applies, with the skills it names. It overrides existing code.
- Files inside the area end fully compliant, not only the changed lines. At a call site, only the code that uses the area must; the rest of that file is outside the area.
- Within the area, any means: rename, move, merge, split, delete or restructure to reach the best shape.
- Change behaviour only to fix a bug.
- Outside the area and its usage, change only what the area's changes require.
