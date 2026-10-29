# Agents

Read this when you author an agent. Not routine reading.

## Writing one

Frontmatter fields in use here: `name`, `description`, `tools`. The full
supported set is on https://code.claude.com/docs/en/sub-agents — read it rather than guessing.

`description` is what a task gets matched against, so write it around the **kind of work**,
not the cost tier. "Audits an HTTP handler against its invariants" is selectable; "opus at max
effort" is not.

Only an agent that must write gets `Edit`/`Write`. A reviewer that can edit will "fix" what it
was asked to judge, and the evidence disappears.

## Model and effort

Every subagent runs on the session's model and effort. Omit `model` and `effort` from a
definition and `model` from every `Agent` call; both are then inherited. The user-level agents in
`~/.claude/agents/` (`auditor`, `reviewer`, `quick`, `worker`) pin their own, so they are not
dispatched here.

A Fable session's fan-out fails with HTTP 429 `session limit`: run fan-out work from an Opus
session. The only reliable confirmation of the effort a subagent ran at is the top-level `effort`
field in its transcript, `~/.claude/projects/<cwd>/<session>/subagents/agent-*.jsonl`.

## A new file is invisible to the session that wrote it

The registry is built at session start. Either write the whole set before the work starts, or
dispatch to a fresh definition by shelling out, since a new process rereads the directory:

```
claude -p "Use the Agent tool with subagent_type '<name>' ..."
```

Add `--dangerously-skip-permissions` only when the parent session is already running that way.
Never stop and ask for a restart.
