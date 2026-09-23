---
name: actari
description: Use when recording delegated work in the actari journal (MCP server) — drafting tasks, delegating, reporting, accepting — and when you need the rules that apply to a project (get_policy). Teaches the protocol, not a methodology.
---

# Actari — the journal protocol

The journal is the `actari` MCP server (tool names may be prefixed, e.g.
`mcp__actari__*`): an append-only event log over SQLite with task,
artifact and incident projections and full-text search. If it is not
connected, add it first:

```json
{ "mcpServers": { "actari": { "command": "npx", "args": ["-y", "github:actari/actari-mcp"] } } }
```

The server needs Node.js >= 22.5 and keeps its data in `~/.actari/`.

## Statuses

```
DRAFT → DELEGATED → REPORTED → ACCEPTED | REWORK (→ DELEGATED …) | FAILED
```

`REPORTED` means *the executor believes it is done*. `ACCEPTED` means
*confirmed by a check*. They are different facts: never present a report as
completion. Status changes happen only through the journal's tools — the
server validates every transition.

## Rules come from the policy, not from this skill

How to draft, what a report must contain, what counts as acceptance — all of
that is the **project's policy**, data the server reads from `policy.json`
(set locally with `set_policy`) or pulls from the project's cloud workspace.

- `get_policy { project }` — the full effective policy: two enforcement
  switches (`accept_requires_evidence`, `draft_requires_artifact`) and free
  text guidance for the four acts `draft`, `delegate`, `report`, `accept`,
  plus where it came from (workspace / project / default / lenient).
- The short version is embedded in the descriptions of `draft_task`,
  `delegate`, `submit_report` and `accept` — read the description before
  calling the tool.
- Without any policy the server is *lenient*: it records, it does not judge.

## Tools

| Group | Tools |
|---|---|
| Registry | `resolve_project`, `register_project`, `list_projects` |
| Task lifecycle | `draft_task`, `delegate`, `submit_report`, `accept`, `request_rework`, `mark_failed` |
| Knowledge | `search_precedents`, `record_artifact`, `get_artifact`, `list_artifacts`, `record_incident` |
| Overview | `get_task`, `list_tasks`, `link_tasks` |
| Policy | `get_policy`, `set_policy` |
| Cloud (optional) | `connect`, `sync_scope`, `sync`, `inbox`, `take`, `intent_status`, `release_intent` |

Prompts: `tasks` (show the journal), `bootstrap` (create the artifact the
policy requires before drafting, if any).

## Journal rules

- Projects are registered first (`resolve_project` → `register_project`);
  tasks and artifacts are accepted only for registered projects. A task id
  is `<project>/<date>-<slug>` — the project namespace is part of the id.
- Artifacts (`spec` / `plan` / `adr` / `decision` / `note` / `doc`) are
  versioned: recording the same `title` again creates a new version, the old
  one stays in history.
- `accept` takes `evidence` — what confirmed the acceptance (a commit hash,
  a CI run, a test output). Whether it is required is the policy's call.
- Continuing a closed task is always a **new** task plus `link_tasks`
  (`kind: continues`); the rework cycle lives only inside an open task. Work
  discovered along the way becomes a new task plus `discovered_from`.
- The journal is information for search and retrospectives; whatever proves
  acceptance in your team is defined by your policy, not by a database row.

## The cloud — optional

`connect` checks the connection and writes the sync config; every journal
write is then pushed upstream. `sync_scope` binds projects to workspaces.
`sync` forces a push and refreshes the cached workspace policies. `inbox` /
`take` pull task intents from the cloud. The cloud never rewrites the
journal. A human can cancel, close or take back an intent and change its acceptance criteria; the server then refuses the next act and says why. `intent_status` shows the intent; `release_intent` gives a taken intent back.
