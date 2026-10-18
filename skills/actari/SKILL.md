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
{ "mcpServers": { "actari": { "command": "npx", "args": ["-y", "actari-mcp"] } } }
```

The server needs Node.js >= 22.5 and keeps its data in `~/.actari/`.

## Getting started

Do these in order the first time you work in a repository:

1. **Register the project first.** Call `resolve_project { path }`; if nothing
   comes back, `register_project { name, root_path }`. Without a registered
   project the journal refuses every task and artifact, so nothing below works
   until this is done.
2. **A task from a human goes through the journal.** When the person asks for
   work ("do X, and track it in actari"), run it as `draft_task` → `delegate`
   → `submit_report` → `accept`. Read `get_policy { project }` before the first
   call — it says what a draft, a report and an acceptance must contain.
3. **A feature from a discussion is published, not drafted.** When a
   conversation ends in an agreed feature, call `publish_intent { project,
   slug, title, text, acceptance_criteria }`; the cloud creates the feature and
   its intent, and the work continues from there with `take`.
4. **Work from the cloud comes through `inbox` and `take`.** `inbox` lists the
   intents waiting for you; `take { task_id }` claims one and returns a blank
   for `draft_task` (pass its `intent_task_id`). Both need a cloud connection:
   if the person gave you an address and a token ("connect actari"), call
   `connect { token }` first.

If the journal answers that a project is not registered, go back to step 1.
If the cloud shows nothing while the person belongs to several workspaces,
bind the project with `sync_scope`.

## Statuses

```
DRAFT → DELEGATED → REPORTED → ACCEPTED | REWORK (→ DELEGATED …) | FAILED
DRAFT → DROPPED (drop_task, with a reason — closes a draft you don't want)
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
| Task lifecycle | `draft_task`, `delegate`, `submit_report`, `accept`, `request_rework`, `mark_failed`, `drop_task` |
| Knowledge | `search_precedents`, `record_artifact`, `get_artifact`, `list_artifacts`, `record_incident` |
| Release | `record_release` (not tied to a task — records what shipped to prod; pass `notes` with a human title and a one-line "what's new" per item — the cloud builds the Telegram release message from them) |
| Overview | `get_task`, `list_tasks`, `link_tasks` |
| Policy | `get_policy`, `set_policy` |
| Cloud (optional) | `connect`, `sync_scope`, `sync`, `inbox`, `take`, `intent_status`, `release_intent`, `publish_intent` |
| Time (cloud only) | `log_time` (log hours on a cloud task as the token owner; never writes locally) |

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

## ADR

Record an architectural decision as its own artifact: `record_artifact
{ project, kind: "adr", title, body, task_id }`.

- **When.** A choice of data model, library, protocol or module boundary, or
  any decision that is costly to reverse. A decision made during a task is
  recorded as an ADR in its own right — not buried in the report, a spec or a
  note. Routine implementation choices are not ADRs.
- **Format.** A markdown body with sections `## Context` and `## Decision`
  (both required), plus optional `## Consequences` and `## Alternatives`.
  Russian headings (`Контекст`, `Решение`, `Последствия`, `Альтернативы`) work
  the same. Without a non-empty Context and Decision the journal refuses the
  record and answers with a template.

  ```
  ## Context
  Reports are rendered on three screens; each parses the text differently.

  ## Decision
  Store the report as structured sections and render them in one place.

  ## Consequences
  A migration for old reports; one renderer to maintain.

  ## Alternatives
  Keep free text and parse on read: cheaper now, fragile later.
  ```
- **Binding.** Pass the `task_id` of the task the decision belongs to — the
  cloud then attaches the ADR to that task's feature. A spec-level decision is
  bound to the first task it affects. Without a `task_id` the ADR goes to the
  workspace's general section.
- **Updating.** Recording the same `title` again updates the same ADR in the
  cloud (a new version; the old one stays in the journal history).
- **In the cloud.** The ADR appears in the feature's documents and on the
  Documentation page, marked "from the journal". Its status follows the task:
  proposed until the task is accepted, then accepted.

## The cloud — optional

`connect` checks the connection and writes the sync config; every journal
write is then pushed upstream. `sync_scope` binds projects to workspaces.
`sync` forces a push and refreshes the cached workspace policies. `inbox` /
`take` pull task intents from the cloud. The cloud never rewrites the
journal. A human can cancel, close or take back an intent and change its acceptance criteria; the server then refuses the next act and says why. `intent_status` shows the intent; `release_intent` gives a taken intent back. `publish_intent` publishes a brief to the cloud: it creates or updates a feature and its intent keyed by `(project, slug)`; a card closed by a human is never recreated.

`log_time { task_id, hours, date?, note? }` logs time on a cloud task (a cloud task id, or a journal task id that has an `intent_task_id`); minimum 15 minutes, `date` defaults to today, nothing is written to the local journal. When you submit a report, pass `duration_minutes` (integer 1–1440) if you know how long the work took — the cloud then uses it as the AI time instead of estimating.
