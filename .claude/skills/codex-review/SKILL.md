---
name: codex-review
description: Get a second opinion from OpenAI's Codex CLI (GPT-6.1 sol, xhigh) on a change, a design question or an audit claim, then argue back with evidence. Use when the owner asks for a GPT, Codex or second-model review or discussion.
---

Codex is a reviewer, not an authority. Its findings are claims: check each against the code, accept what holds, and answer what doesn't with evidence.

## Run it

`codex` is on PATH (a Bun global). `~/.codex/config.toml` already defaults to `gpt-6.1-sol` at `xhigh`; pass both anyway so a config change can't silently downgrade the review. It takes 10–25 minutes: run it in the background and keep working.

```bash
S=<your scratchpad>
codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' -s read-only \
  -C "D:/apps/job-app/soft-house-dash-4" --color never \
  -o "$S/codex-1.md" - < "$S/brief.md" > "$S/codex-1.log" 2>&1
```

- `-s read-only`, always: it reviews, the owner decides what lands. It can still read files and run read-only commands.
- `-o` gets the final answer only; the log holds the whole transcript.
- Web research (standards, how large providers do something): `--search` is a top-level flag and goes before `exec`: `codex --search exec …`.
- Follow-up in the same conversation, so it keeps its context. Take the id from the log's `session id:` line. `resume` has no `-s`, so set the sandbox through config:

```bash
codex exec resume <session-id> -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' \
  -c 'sandbox_mode="read-only"' -o "$S/codex-2.md" - < "$S/reply.md" > "$S/codex-2.log" 2>&1
```

## The brief

Write it to a file and pipe it in; it is the only context Codex gets.

- Tell it to read the root `CLAUDE.md` and the app's `CLAUDE.md` first, and to edit nothing.
- Per change: what changed, why (the defect, with the evidence), the files, and the test that covers it. Say what you already verified (commands and results) so it doesn't redo it or assume it wasn't done.
- What to probe: races and lock order, other paths to the same operation, contract and OpenAPI impact, migration safety, whether each test would catch a regression and asserts durable state.
- The answer you want: numbered findings with `file:line`, severity, a concrete scenario and the smallest fix, then a "checked and fine" list. Ask it to say when it is unsure and to push back on your reasoning rather than agree.
- Never paste secrets or `.env` contents.

## Answer it

- Verify every finding before acting. Where it disputes a cost or a plan, measure it on a throwaway database rather than argue; numbers settle what reasoning doesn't (it has withdrawn findings when shown measurements).
- Fix what holds. For each point you reject, reply with the evidence (`file:line`, measurements, the guard it missed) and ask it to re-review the revised diff.
- Read-only means it cannot run this repository's test tiers (they write to Postgres and SQLite). Its "probes" are static or read-only; weigh them accordingly.
- Report to the owner what Codex raised, what you accepted and rejected, and why.
