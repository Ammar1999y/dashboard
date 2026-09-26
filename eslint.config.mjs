// Root-level sources (`scripts/`) are linted with the back-end ruleset they
// were extracted from, so moving a file up to the root cannot weaken its lint.
// The workspaces keep their own configs; ESLint picks the nearest one.
export { default } from './apps/back-end/eslint.config.mjs';
