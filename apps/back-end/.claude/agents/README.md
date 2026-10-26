# Agents

Read this when you author an agent. Not routine reading.

## Writing one

Frontmatter fields in use here: `name`, `description`, `model`, `effort`, `tools`. The full
supported set is on https://code.claude.com/docs/en/sub-agents — read it rather than guessing.

`description` is what a task gets matched against, so write it around the **kind of work**,
not the cost tier. "Audits an HTTP handler against its invariants" is selectable; "opus at max
effort" is not.

Only an agent that must write gets `Edit`/`Write`. A reviewer that can edit will "fix" what it
was asked to judge, and the evidence disappears.

## Model and effort

`model` is `opus` or `sonnet`, here and in any per-call override. Never Fable — a fan-out of
Fable agents fails with HTTP 429 `session limit`. Never Haiku — it has no effort levels.

`model` can be passed per `Agent` call. **`effort` cannot** — it exists only in a definition
file. Levels are `low|medium|high|xhigh|max`; a level the model does not support silently falls
back to the highest one below it. Omitting `effort` inherits the session's.

**An effort equal to the session default is a silent no-op.** Read `effortLevel` in
`~/.claude/settings.json` before choosing. The only reliable confirmation that a declaration
applied is the top-level `effort` field in the subagent's transcript,
`~/.claude/projects/<cwd>/<session>/subagents/agent-*.jsonl`.

## A new file is invisible to the session that wrote it

The registry is built at session start. Either write the whole set before the work starts, or
dispatch to a fresh definition by shelling out, since a new process rereads the directory:

```
claude -p "Use the Agent tool with subagent_type '<name>' ..."
```

Add `--dangerously-skip-permissions` only when the parent session is already running that way.
Never stop and ask for a restart.
