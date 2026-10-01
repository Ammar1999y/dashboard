Review every change in this repository that is NOT yet staged, stage the ones that don't need my review, and write me a short report on the rest. Do the work yourself; don't spawn subagents.

## Scope and hard rules

- Work in `apps/back-end` and `packages/shared` only. Never read, edit, format or stage `apps/front-end`; it's worked on in parallel and its changes aren't yours. Don't run repo-wide commands that write files (root `bun run format`, `lint --fix`, `--filter '*'`).
- Never unstage, restage or modify anything that is already staged.
- Don't edit any source file. This task only stages and reports.
- Stage with `git --literal-pathspecs add` (paths contain `[id]`). Afterwards, confirm each staged file has nothing left unstaged.
- Don't commit. Never use `git stash`.

## What to stage without asking

A change doesn't need my review if it doesn't change behaviour:

1. Import paths, import order, or the import style.
2. Comments added, removed or rewritten.
3. Files deleted and moved elsewhere, and one file split into several (or several merged into one). For moves you don't need to keep the old and new file staged together.
4. Repeated code pulled into a helper that does exactly what the inline code did. Open the helper and compare it with the code it replaced: same checks, same order, same messages, same status codes, same defaults. A removed argument is fine only if the new default equals the value that was passed.
5. Renamed local variables or parameters, dropped `as` casts, `interface` ↔ `type`, and new type aliases for existing types.
6. A literal replaced by a constant with the identical value (check the value).
7. Deleted declarations that nothing references any more (grep the whole repo first), including unused message entries in a moved messages file.
8. Small tidy-ups that barely change logic, such as `if/else` → `switch` with the same branches, or `x?.y` where `x` can't be missing.

If a file is 95% refactor but has one real change, stage it and list the change in your report. Don't hold the whole file back for it.

## What NOT to stage (list these for me)

- New logic: new checks, new branches, changed limits, a changed order of operations, different error status codes or messages, or changed database queries.
- A changed default or an interface change that callers could notice. Example: a presigned-URL default changing from 300 to 3600. Check the current callers and say whether any of them is affected today.
- New configuration or tooling decisions: new root or workspace `package.json`, `bunfig.toml`, `tsconfig*.json`, eslint/prettier configs, `lefthook.yml`, `.gitattributes`, `.dockerignore`, `.gitleaks.toml`, `.npmrc`, `scripts/*.mjs`, `patches/`, lockfiles.
- Notes files (`prompt.md`, `*-review.md`, and similar) and anything that looks misplaced. For example, a `data-table/` folder of React components at the repository root.

"This is auth / 2FA / OTP / security code" is NOT on its own a reason to hold a file back. Read it: if it is a verified refactor, stage it.

## How to decide efficiently

- For each file, compare the staged version (`git show :path`, or `HEAD:path` if the old file's deletion is already staged) with the working tree, statement by statement, ignoring imports, comments and formatting. The TypeScript printer with `removeComments: true` works well for this.
- For moved code, match each removed declaration with a declaration elsewhere, by exact text or by name, and word-diff the pairs. Only the differences need reading.
- Group files that exchanged code and judge each group once.
- Before staging, run `bunx tsc --noEmit` and `bun run test` in `apps/back-end` (the unit run takes about 5 minutes, so run it in the background). Report the exact result.

## When to ask me

Only if something is genuinely ambiguous and none of the rules above settles it. Otherwise decide, stage, and explain in the report. Don't stop halfway to ask "should I stage these?". The rules above are my answer.

## Report (a markdown file, `unstaged-review.md` at the repository root)

1. **Summary:** how many files you staged, the test and type-check results, and how many files are left.
2. **What still needs my review:** for each item, the file(s), what changed in one or two plain sentences, and why it matters. If the same kind of change appears in several files, describe it once and list the files.
3. **Small real changes you staged anyway:** one line each.
4. **Left alone and why:** front-end, misplaced files, notes.

Don't include file-by-file lists of pure moves or deletions. The report is only for things I actually need to look at.
