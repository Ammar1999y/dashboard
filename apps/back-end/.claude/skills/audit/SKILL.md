---
name: audit
description: Whole-codebase audit of the back-end and the shared sources it imports (defects, better approaches, performance), written to reports/<model>-audit.md. Run only when asked.
disable-model-invocation: true
argument-hint: '[narrower scope — default: the whole back-end]'
---

Paths are relative to `apps/back-end`. Read `CLAUDE.md` first. Audit the code against its code-facing standards; its agent-behaviour rules govern you, not the code. Report any conflict between it and the code.

Then read [brief.md](brief.md). It is what every subagent works from, and all of it except Writes and reads and Return binds you too.

Requested scope: $ARGUMENTS

Nothing after the colon means the default in the brief: the whole codebase, not a diff.

## Orchestration

- You are the orchestrator: map the scope, split it into coherent areas, dispatch subagents, cross-check their evidence, decide what is a finding.
- The areas together hold every file in scope, and each is small enough for one subagent to read in full. A subagent that still finds its share too big hands part of it to helpers, as the brief says; its return then covers their files too.
- Before dispatching, run one existing integration test. If Postgres or the harness is unreachable, tell every subagent that verification is reasoning plus the unit tier.
- Dispatch `general-purpose` subagents with no `model` override, so they inherit this session's model and effort (${CLAUDE_EFFORT}). Not the user-level `auditor` or `reviewer`: their definitions pin an effort of their own.
- Subagents do not see this skill. Every prompt, for area, documents, seam and verifier subagents alike, tells it to read `${CLAUDE_SKILL_DIR}/brief.md` before anything else. An area prompt also names its area, lists its files, and pastes the entries of `reports/should-ignore.md` (both lists), `TODO.md` and `reports/performance-audit.md` that touch its area. Entries already in the audit report go in as exclusions, title and root cause only, never as examples to hunt by.
- Area subagents collect suspects; they don't adjudicate. You alone write the report.
- **Documents pass.** Alongside the areas, one fresh subagent checks every requirement in `reports/coolify-deployment.md` against the code it configures (names, values, paths, scripts, order), and every owner entry whose code no area holds, finding where that code went or confirming it is gone. A deployment step that would now break or weaken production is a suspect; the rest of what no longer matches are stale entries.
- **Seam pass.** After the areas return, give one fresh subagent the area split and the merged suspects. It hunts only across area boundaries (contract entry ↔ binding ↔ `lib`, auth hooks ↔ modules, a write path ↔ the jobs that clean up after it) and names every entry point or parallel path to the same operation that no area covered; dispatch those before verifying. It also returns what no single area can see: one concern implemented differently in several areas, and a design choice whose cost lands across them.
- **Coverage.** Each return lists the files it read in full; a file in scope that no return lists is uncovered. So is an area whose subagent failed, timed out or returned nothing usable. Re-dispatch it or list it as a limitation. A clean return must name what it checked.
- **Verify before writing.** Give each suspect to a fresh subagent that did not produce it: the claim and its evidence, not your verdict; at most about 15 per verifier. Its starting verdict is refuted, and it hunts no new suspects. It restates the claim, then keeps a defect only after it has:
  - found no guard that stops it, having read each candidate guard: the zod contract at `bind()`, database constraints, Better Auth's internals, the rate-limit layer, the caller. A guard it has not read is not a guard; a comment or stated rationale is a claim, not a guard. A guard counts only if it runs on every path to the effect, before the effect, with no branch that fails open.
  - for a refutation by execution, seen the guard it names produce the rejection (its error, not the status alone) while a benign twin of the request passes.
  - confirmed the attacker's reach and what they gain beyond their position.
  - confirmed any `CLAUDE.md` rule the claim cites says what it is quoted as saying.
  - for a reproduction, seen it fail on its own assertion, not from setup, an import or the environment.

  It keeps an improvement only after it has:
  - re-measured the claimed cost, or re-derived it from the code.
  - confirmed on the installed version that the alternative exists and keeps every behaviour callers rely on.
  - found nothing that forced the current shape: a library internal, a lifecycle order, a deployment fact.
  - for unused code, searched the whole repository, including tests, scripts, CI, config and string or dynamic references, and found no use.

  It keeps a stale entry only after it has seen, in the current source, the change the claim names.

  A mitigation that lives in deployment (`coolify-deployment.md`, Cloudflare) lowers severity only while the documented step still matches the code it configures; it never refutes. When the decisive fact is outside the repository and no local check can settle it (proxy, Cloudflare or provider behaviour), the suspect is neither written nor dropped: it goes to the final response with that exact fact and the check the owner can run. Write only what survives, at the severity the verifier's evidence supports.

- Existing report entries go through the same verifier against the current source; the code may have changed since they were written.

## Writes and reads

- The only change to the repository is the audit report. This overrides `CLAUDE.md`'s allowance for retained test files, for subagents too. Postgres and R2 follow the brief's rule.
- Verification may use `bun -e`, a REPL, targeted existing tests, read-only commands, and temporary files deleted before finishing.
- `reports/`: read only this audit's report and the files it referenced when the audit began, `should-ignore.md`, `performance-audit.md`, and `coolify-deployment.md` when a server/VPS/Coolify/proxy/Cloudflare suspect needs checking against it; the documents pass reads it in full. Both override `CLAUDE.md`'s reading policy. Never edit the latter; server findings go in the audit report (overrides `CLAUDE.md` routing).
- `docs/`: read only files explicitly shared with you or referenced.

## Report

- Read `reports/should-ignore.md`, `TODO.md` and `reports/performance-audit.md` first. Many entries were written against older code: one excludes a suspect only once a subagent has confirmed it still describes the current source. Then skip what it documents unless new evidence changes its impact, disproves its reasoning, or reveals a distinct problem; a shared file or flow is no reason to suppress a different issue. Remediate a bug without removing the design an entry documents.
- The report is `reports/<your model name>-audit.md`, e.g. `reports/opus-5.5-audit.md`. It holds only verified entries: defects under `## Findings`, then approach, shape and performance opportunities under `## Improvements`, then owner entries that no longer match the code under `## Stale entries`. No progress, file lists, searches, empty checks, suspicions or limitations.
- Write each entry as soon as it is verified. One entry per root cause and remediation. Keep existing entries unless their verification disproves them; then remove them and say why in the final response.
- Plain English, short sentences. A title says what goes wrong or what gets better, not the mechanism, and a reader who has not opened the file understands the entry on its own.
- Each finding: severity; `file:line` and symbol, or the affected flow / missing repo-level requirement; evidence; impact; remediation: the smallest change that fixes the whole class, preferably one that deletes code or reuses what exists, changing behaviour only to fix the bug and never narrowing a contract. Behavioural and security defects need a concrete failure scenario: input, state and outcome, and why the existing guards don't catch it. Add a `CLAUDE.md` reference, Bun source, missing test or verification command only when relevant.
- Each improvement: `file:line` and symbol, or the area; what the code does now and what that costs, with the evidence; the alternative, or each of several, with what it gains and what it costs (contract, schema and migration, call sites, risk); for a shape change, the target shape and every call site it reaches; the findings it would also close, by number. Those findings stay listed, since each needs its fix whether or not the improvement is taken.
- Each stale entry: the document and the entry, by id or heading; what changed (fixed, moved to `file:line`, no longer true) and the evidence. The documents stay untouched; the owner updates them.
- Severity, for findings, follows `CLAUDE.md`'s priorities and the brief's threat model. **Critical:** severe impact with nothing in the way. **High:** behind one real hurdle. **Medium:** bounded impact, or needs several conditions. **Low:** limited impact and demanding conditions. Unreachable today but unprotected is a finding at lower severity; say what would make it reachable. Severity never exceeds the impact actually shown: a crash is not code execution, routine load is not an outage, a user acting on their own data is not privilege gain. Between High and Medium: does the result fully defeat a control with real consequences, or only weaken it?

## Finish

Cover the whole scope, then: merge duplicates, recalibrate severities against the scale, and number the entries in one sequence (findings by severity, then improvements by gain against cost, then stale entries) so the owner can name them ("fix 2 and 5"). Confirm the repository changed only in the audit report, and that no database or `probe/` object created during the run remains. The final response lists verification limitations; the suspects held on a fact outside the repository, each with the owner's check; every suspect you dropped with its reason (the guard, constraint or confirmed owner entry that refuted it, at `file:line`, or the evidence that was missing), so a wrongly dropped one can be caught; and the areas covered most thinly. One run is not exhaustive, so never claim it is; the thin areas are where the next run starts.
