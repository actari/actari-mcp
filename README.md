# actari

[![npm](https://img.shields.io/npm/v/actari-mcp)](https://www.npmjs.com/package/actari-mcp)
[![skills.sh](https://img.shields.io/badge/skills.sh-2_skills-8A2BE2)](https://skills.sh/actari/actari-mcp)
<!-- TODO: когда каталог проиндексирует установки, вернуть живой счётчик: https://skills.sh/b/actari/actari-mcp -->

**A task journal for AI agents. The rules are yours.**

An append-only event log over SQLite (tasks, reports, artifacts, incidents,
full-text search) exposed as an MCP server. Zero dependencies — only
Node.js >= 22.5 with the built-in `node:sqlite`.

The journal knows one thing for sure: `DRAFT → DELEGATED → REPORTED →
ACCEPTED | REWORK | FAILED`, plus `DRAFT → DROPPED` through `drop_task` (drop
a draft you no longer want, with a reason), where *reported* (the executor
believes it is done) is never the same as *accepted* (confirmed by a check).
Everything else — what a task must contain, what a report must show, what
counts as acceptance — is a **policy**: data you set per project or per cloud
workspace, not opinions baked into the package. A separate act,
`record_release`, records what shipped to prod (`Released`) — not tied to
any single task; pass `notes` (a human title and a one-line "what's new" per
item) and the cloud builds the Telegram release message from them.

## Quick start

**What each part is for.** The **MCP server** (`actari-mcp`) is the journal on
your machine: the agent keeps tasks, reports and artifacts in it with tools,
and it pushes them to the cloud. The **skills** teach the agent: `actari`
the journal protocol and `feature` the working order for one feature (see
[First feature in 10 minutes](#first-feature-in-10-minutes)). The protocol:
register the project first, run a task from a human through the journal,
publish a feature from a discussion with `publish_intent`, take work from
the cloud with `inbox` / `take`. The
**policy** holds the rules of drafting, reporting and accepting; it is set per
project (`set_policy`) or in the cloud workspace and read with `get_policy`.
The cloud adds the board, acceptance and the team on top of the journal.

**1. Sign up and create a workspace** in the cloud, then **issue an MCP
token** on the MCP tokens page (a write token — a read-only one cannot
connect).

**2. Install the plugin.**

*Claude Code — two commands* (installs the MCP server *and* the skill):

```bash
claude plugin marketplace add https://github.com/actari/actari-mcp
claude plugin install actari@actari
```

*Any other agent* — install the skill, then add the MCP server to your
agent's MCP config:

```bash
npx skills add actari/actari-mcp
```

```json
{ "mcpServers": { "actari": { "command": "npx", "args": ["-y", "actari-mcp"] } } }
```

**3. Connect to the cloud.** Tell the agent: "Connect actari: address
`<your cloud address>`, token `act_...`". It calls `connect { "token": "act_..." }`
(see [Connect to the cloud](#connect-to-the-cloud-optional)).

**4. Register the project.** In the repository folder tell the agent:
"Register this project in actari". Without a registered project the journal
refuses every task.

**5. Run the first feature.** Follow
[First feature in 10 minutes](#first-feature-in-10-minutes): one sentence to
the agent, one "ok", and you watch the feature go from the board to
"accepted" and "shipped".

Optionally, pin the journal at the project level — copy this into your
`AGENTS.md` / `CLAUDE.md`:

```markdown
Delegated work is recorded in the `actari` MCP journal: `draft_task` →
`delegate` → `submit_report` → `accept`. The rules for each step come from
`get_policy { project }` and are echoed in the tool descriptions.
```

## First feature in 10 minutes

Prerequisites: steps 1-4 of [Quick start](#quick-start) (cloud workspace and
token, plugin installed, cloud connected, project registered). The `feature`
skill drives everything below; in Claude Code it is `actari:feature`. Without
the cloud the same cycle runs in the local journal.

1. **You say:** "Please do it through actari: add CSV export of the report"
   (or in Russian, "Сделай через actari: …"; the agent answers in your
   language). **The agent:** registers the project if it is new, reads its
   policy, and shows you a short intent: what it will do, what it will not,
   and 3-5 criteria for "done". **You:** answer "ok" or correct it. This is
   the only stop before acceptance.
2. **The agent:** records the intent (`intent: <slug>` in the journal),
   publishes it with `publish_intent`, and cuts the work into 1-3 tasks.
   **In the cloud:** the feature appears on the board with its intent and
   criteria.
3. **The agent:** drafts, delegates and does each task, then submits a
   report with the commands it ran and their output. **In the cloud:** each
   task moves *in progress* then *reported*.
4. **The agent:** hands every task to a separate reviewer that has none of
   its context. The reviewer reads the report and the diff, runs the checks
   itself and returns `verdict: accept | rework | failed` with evidence; the
   verdict is recorded as an `acceptance: <task>` artifact. **In the cloud:**
   *reported* then *accepted* (or back to rework). In a client without
   subagents the agent shows you the report and evidence and accepts only
   after you say ok. The agent never accepts its own work.
5. **The agent:** writes a summary: what is done, what proved it, what is
   left, where to look. **You:** see the accepted tasks on the board.
6. **You ship it yourself, then say:** "Shipped." **The agent:** records the
   release with `record_release` and syncs. **In the cloud:** the release
   appears, and the notification reaches Telegram.

**Take it from actari.** Created the feature in the cloud instead? Add tasks,
press "Take into work", and tell the agent: "Take it from actari." It reads
the `inbox`, takes the intent with `take`, and runs steps 3-6 on it without
writing its own intent.

### Nothing showed up?

- The project is not registered: tell the agent "Register this project in
  actari". Without it the journal refuses every task.
- Node.js is older than 22.5: the server does not start. Check
  `node --version`.
- The token is read-only: `connect` and `sync` need a write token. Issue a new
  one on the MCP tokens page.
- You belong to several workspaces: bind the project with `sync_scope`.
- No cloud connected: the cycle still works in the local journal. Look there
  with `list_tasks`; nothing is pushed until you `connect`.

## Install

Add the server to your `.mcp.json`:

```json
{
  "mcpServers": {
    "actari": {
      "command": "npx",
      "args": ["-y", "actari-mcp"]
    }
  }
}
```

Or run it straight from a checkout:

```json
{
  "mcpServers": {
    "actari": {
      "command": "node",
      "args": ["apps/mcp/server.mjs"]
    }
  }
}
```

Data lives in `~/.actari/journal.db` (override with `ACTARI_DB`).
On first start the server creates the directory and the database itself.
`sync.json` always sits next to the database.

## Connect to the cloud (optional)

`connect` needs only a token — the managed Actari cloud is the default.
The token is **personal** (a PAT, like on GitHub): one token covers every
workspace you are a member of, and the journal is routed between them by
`sync_scope`:

```
connect { "token": "act_..." }
```

Tokens come in two kinds: **write** (the default) and **read-only**. `connect`
and `sync` require a write token; a read-only token gets `403 read-only token`.
For agents that only need to read the cloud journal, use the separate package
[`actari-reader`](https://www.npmjs.com/package/actari-reader)
(`npx -y actari-reader`) together with a read-only token.

A human can cancel, close or take back an intent and change its acceptance
criteria; the server then refuses the next act and says why. `intent_status`
shows the intent; `release_intent` gives a taken intent back.

`publish_intent` publishes a brief to the cloud: it creates or updates a
feature and its intent keyed by `(project, slug)`; a card closed by a human
is never recreated.

`feature_questions { project, slug }` lists the AI product owner's questions
on a feature (id, status, text, link and the reply thread); `answer_question
{ project, slug, question_id, text }` writes an answer into the question's
thread, signed with the token owner's name and marked "via MCP". The feature is
addressed by the same `(project, slug)` key as `publish_intent`, in the
project's `cloud_workspace_id`.

`log_time { task_id, hours, date?, note? }` logs time on a cloud task as the
token's owner, exactly like "Log time" in the task card (minimum 15 minutes,
`hours: 1.5` = 1 h 30 min, `date` defaults to today). `task_id` is a cloud
task id or a journal task id that has an `intent_task_id`. It writes **only to
the cloud** — never to the local journal — and fails with a clear message when
no cloud is connected. `submit_report` accepts an optional `duration_minutes`
(integer, 1–1440); when given, the cloud uses it as the AI time of the task.

`log_usage { project, task_id, role, source, session?, usage_file? }` records the AI
tokens a task cost in the local journal (`UsageRecorded`; status is not
changed, any status except DRAFT). `role` is `executor` or `acceptance`;
`source` is `subagent` (a Claude Code subagent or forked skill) or `headless`
(an external executor). Tokens are found by the server, not copied by the
agent. With `session: { client, id }` it looks the session up by the id the
client returned: `claude-code` — the `agentId` of a subagent (transcript in
`<CLAUDE_CONFIG_DIR|~/.claude>/projects/…/subagents/agent-<id>.jsonl`) or the
`session_id` of `claude -p`; `opencode` — the `ses_…` id from the `task` tool
result (read-only from `<XDG_DATA_HOME|~/.local/share>/opencode/opencode.db`);
`codex` — a `thread_id` or the `task_name` that `spawn_agent` returned
(rollouts in `<CODEX_HOME|~/.codex>/sessions`). With `usage_file` it counts a
file: a subagent transcript, the output of `claude -p --output-format json`,
`opencode run --format json` or `codex exec --json`. One source per call —
`session`, `usage_file` or numbers (`total_tokens`, or the input/output/cache
breakdown, only the sum for the whole work, never the context size of the last
turn). The client files are internal formats, not a promised API: if one
changes, the call is refused with a reason and nothing is recorded. The
`feature` skill calls it after the executor and after the acceptor; the cloud
shows the numbers next to the AI time of the task.

### Self-hosted (on-premise)

Pass the **base URL** of your instance; endpoint paths are derived by the server,
so a reverse-proxy prefix works as-is:

```
connect { "url": "https://actari.acme.internal", "token": "act_..." }
connect { "url": "https://tools.acme.com/actari", "token": "act_..." }
```

The resolved base is stored in `sync.json` next to the database. To point every
run at your instance without passing a URL, set `ACTARI_CLOUD_URL`.

### Configure from `.mcp.json` instead

If you would rather keep the credentials with the rest of your MCP config —
no `connect` call, no `sync.json` — pass them as environment variables. They
take precedence over the file:

```json
{
  "mcpServers": {
    "actari": {
      "command": "npx",
      "args": ["-y", "actari-mcp"],
      "env": {
        "ACTARI_SYNC_URL": "https://actari.dev",
        "ACTARI_SYNC_TOKEN": "act_..."
      }
    }
  }
}
```

`ACTARI_SYNC_URL` takes the same **base URL** as `connect`. The journal id
defaults to `<user>-<host>`; override it with `ACTARI_SYNC_JOURNAL_ID` when
one machine feeds several journals.

### Several workspaces at once

One machine, one journal — but projects may belong to different teams. List the
targets in `sync.json` and the journal is pushed to every one of them, each with
its own cursor and its own scope:

```json
{
  "targets": [
    { "alias": "acme", "url": "https://wh.acme.internal", "token": "act_...", "journalId": "kv-mac" },
    { "alias": "lab",  "url": "https://actari.dev", "token": "act_...", "journalId": "kv-mac" }
  ]
}
```

`connect { "alias": "lab", "token": "act_..." }` adds a target instead of
replacing the config. On a flat config without an `alias` it overwrites, exactly
as before; once a `targets` list exists it replaces only its own entry — matched
by alias, or by url plus journal id — and leaves the neighbours alone. The
flat single-target form (`{url, token, journalId}`) keeps working untouched, and
so do the `ACTARI_SYNC_*` variables — they describe one target, so when a
`targets` list is present they are ignored with a line on stderr rather than
silently adding a third destination.

A target that is down does not hold up the others: the push reports per target,
and a failing one is a line on stderr, never a crash.

### Which projects are pushed (sync scope)

The journal is one per machine and holds every project you work on, while a
cloud workspace belongs to a team. The token is personal, so the cloud reports
every workspace you are a member of, and each push fans the journal out across
them by the project mapping. Bind projects to a workspace by its **slug**:

```
sync_scope {}                                                  # what would be pushed where, and why
sync_scope { "workspace": "acme", "projects": ["acme-web"] }   # bind these to that workspace
```

`sync_scope` asks the cloud for the workspace list itself and records the id as
`cloud_workspace_id` in the project registry — no manual ids, no SQLite editing.
With a single workspace the `workspace` argument may be omitted. With several
targets (servers), binding also names the target by its alias:
`sync_scope { "target": "acme", "workspace": "team", "projects": ["acme-web"] }`.
`ACTARI_SYNC_PROJECTS="acme-web,acme-api"` overrides the registry for one
process, but only while you have a single workspace — with several it names the
projects yet not the destination, so it is ignored with a warning. With no
mapping anywhere: a single workspace receives everything (with a warning, as
before); with several workspaces nothing is pushed until you bind projects —
privacy over convenience.

While a scope is active, events that belong to no project (journal-level
incidents, `_general`) and `ProjectRegistered` stay local. Widening the scope
re-pushes from seq 0 so previously filtered events catch up; the cloud drops
duplicates by seq. The last scope is remembered per target in `sync-state.json`
next to the database (keyed by workspace id), so widening the scope of one target
does not re-push everything to the others.

If your instance uses a certificate from an internal CA, give Node the root
certificate — otherwise the TLS handshake fails and `connect` refuses to write
the config:

```
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/acme-root.pem
```

Sync is one-way: the journal is pushed up, the cloud never rewrites it. The
cursor request is sent with `Cache-Control: no-store`, so a caching proxy in
front of an on-premise instance cannot serve a stale cursor.

## Policies

The server records; a **policy** decides the rules. A policy is a small JSON
document:

```json
{
  "schemaVersion": 1,
  "name": "Evidence first",
  "description": "Accepted means confirmed by something you can check.",
  "enforce": { "accept_requires_evidence": true, "draft_requires_artifact": null },
  "guidance": {
    "draft": "State what must be true when the task is done and how it is proven.",
    "delegate": "",
    "report": "Say what was verified and how — commands and output, not a summary.",
    "accept": "Accept only with evidence you produced or inspected yourself."
  }
}
```

- `enforce` — the two switches the server checks: `accept` without
  `evidence` is rejected; `draft_task` is rejected until an artifact with
  the templated title exists (`{project}` is replaced by the project name).
- `guidance` — free text per act, embedded into the descriptions of
  `draft_task`, `delegate`, `submit_report`, `accept`. Keep each under
  ~1500 characters: it lands in every session's context.

Where it lives: `~/.actari/policy.json`, next to the database.
`set_policy { policy }` sets the default for local projects,
`set_policy { project, policy }` overrides one project; `get_policy
{ project }` shows the effective policy and its source. A project bound to
a cloud workspace (`sync_scope`) takes the workspace's policy only — it is
pulled on start and on every `sync`, and edited in the workspace settings.
Without any policy the server is *lenient*: it records and does not judge.

Built-in presets (`Lenient`, `Evidence first`, `Strict`) are published in
the cloud as public policies — attach or fork one there, or export its JSON
and use it locally with `set_policy`.

## Skills

The package ships two skills:

- `actari` - the journal protocol and the pointer to `get_policy`.
- `feature` - the working order for one feature: intent with one
  confirmation, 1-3 tasks, acceptance by someone other than the author,
  summary, release record. In Claude Code it is `actari:feature`.

Install via the Claude Code plugin (both skills come with it), or:

```bash
npx skills add actari/actari-mcp --skill actari
npx skills add actari/actari-mcp --skill feature
```

## License

MIT
