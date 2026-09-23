# actari

[![GitHub](https://img.shields.io/github/package-json/v/actari/actari-mcp)](https://github.com/actari/actari-mcp)
[![skills.sh](https://img.shields.io/badge/skills.sh-1_skill-8A2BE2)](https://skills.sh/actari/actari-mcp)
<!-- TODO: когда каталог проиндексирует установки, вернуть живой счётчик: https://skills.sh/b/actari/actari-mcp -->

**A task journal for AI agents. The rules are yours.**

An append-only event log over SQLite (tasks, reports, artifacts, incidents,
full-text search) exposed as an MCP server. Zero dependencies — only
Node.js >= 22.5 with the built-in `node:sqlite`.

The journal knows one thing for sure: `DRAFT → DELEGATED → REPORTED →
ACCEPTED | REWORK | FAILED`, where *reported* (the executor believes it is
done) is never the same as *accepted* (confirmed by a check). Everything
else — what a task must contain, what a report must show, what counts as
acceptance — is a **policy**: data you set per project or per cloud
workspace, not opinions baked into the package.

## Quick start

**Claude Code — two commands** (installs the MCP server *and* the skill):

```bash
claude plugin marketplace add https://github.com/actari/actari-mcp
claude plugin install actari@actari
```

**Any other agent** — install the skill, then add the MCP server to your
agent's MCP config:

```bash
npx skills add actari/actari-mcp
```

```json
{ "mcpServers": { "actari": { "command": "npx", "args": ["-y", "github:actari/actari-mcp"] } } }
```

Optionally, pin the journal at the project level — copy this into your
`AGENTS.md` / `CLAUDE.md`:

```markdown
Delegated work is recorded in the `actari` MCP journal: `draft_task` →
`delegate` → `submit_report` → `accept`. The rules for each step come from
`get_policy { project }` and are echoed in the tool descriptions.
```

## Install

Add the server to your `.mcp.json`:

```json
{
  "mcpServers": {
    "actari": {
      "command": "npx",
      "args": ["-y", "github:actari/actari-mcp"]
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

A human can cancel, close or take back an intent and change its acceptance
criteria; the server then refuses the next act and says why. `intent_status`
shows the intent; `release_intent` gives a taken intent back.

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
      "args": ["-y", "github:actari/actari-mcp"],
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

## Skill

The package ships one skill, `actari` — the journal protocol and the
pointer to `get_policy`. Install via the Claude Code plugin, or:

```bash
npx skills add actari/actari-mcp --skill actari
```

## License

MIT
