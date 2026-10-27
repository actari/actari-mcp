---
name: feature
description: Use to run one feature end to end through the actari journal — when the person says "do it through actari", "сделай через actari", "take it from actari", "возьми из actari", or later "shipped" / "выкатил". Covers intent, 1-3 tasks, acceptance by someone other than the author, a summary and the release record. Reply in the user's language.
---

# Feature — one feature, start to accepted

The default way to take a feature from an idea to "accepted" and "shipped"
through the `actari` journal. The tool details (statuses, ADR format, cloud
setup) are in the `actari` skill; this one is the working order. Tool names
may be prefixed (`mcp__actari__*`). Reply in the language the person writes
in; keep ids, slugs and artifact titles in Latin.

## When to use

- "Do it through actari: add CSV export" / "Сделай через actari: …" — a new
  feature from a conversation. Start at step 1.
- "Take it from actari" / "Возьми из actari" — a feature the person created
  in the cloud. Start at step 1, then go to step 3 instead of step 2.
- "Shipped" / "Выкатил" — the feature is on prod. Go to step 7.

Not for a one-line fix the person did not ask to track: use the protocol
from the `actari` skill directly.

## Policy first

From step 2 on (the project exists once step 1 is done; `get_policy`
refuses an unregistered one), call `get_policy { project }` before each
step. The project's policy wins over this skill: whatever it says a draft, a report or an acceptance must
contain, you do. With the `Lenient` policy (nothing set) the default bar
applies: a report carries the commands you ran and their output, and an
acceptance carries evidence a person can re-check.

## 1. Project

`resolve_project { path }` with the repository root. If nothing comes back,
`register_project { name, root_path }` (name = repository folder, lowercase).
Without a registered project the journal refuses every task and artifact.

## 2. Intent

This is the **only stop before acceptance**. Do not ask anything else.

Show the person, in a few lines:

- **What we do** — the feature in one or two sentences.
- **What we do not do** — the nearest things that are out of scope.
- **Done when** — 3 to 5 criteria, each checkable by a command or a visible
  result, not "works well".

Then wait for "ok" or edits. Apply edits and show again only if they changed
the meaning. After "ok", do both, in this order:

1. `record_artifact { project, kind: "note", title: "intent: <slug>", body }`
   with the text and the criteria. Always — it is how the intent survives
   without a cloud. `<slug>` is a short lowercase kebab-case name.
2. `publish_intent { project, slug, title, text, acceptance_criteria }`; on
   success `take { task_id }` with the intent id it returns. If it refuses
   (no cloud connection, project not bound to a workspace), do not stop and
   do not retry: skip the cloud steps and say "worked locally" in the
   summary. Show the person the refusal text as is.

## 3. From the cloud

For "take it from actari": `inbox` lists the intents waiting for you.

- One intent: `take { task_id }`.
- Several: show a short list (title, project) and take the one the person
  names. This is choosing, not confirming — do not ask "ok to proceed?".
- None: say the inbox is empty and, if the person never connected, point to
  `connect { token }` and the README. Stop.

`take` returns the intent, its acceptance criteria and `intent_task_id`. Use
them as they are: the person already wrote the intent, so skip step 2 and
do not publish your own.

## 4. Tasks

Cut the feature into **1 to 3 tasks**. Each is a separate piece that can be
checked on its own; no plan file. For each task:

1. `search_precedents { query }` — what similar work learned before.
2. `draft_task { project, slug, title, task_text, intent_task_id }` (omit
   `intent_task_id` when working locally). `task_text` holds: context, the
   criteria that apply to this task word for word, the order of work, what
   not to touch, and the report format you will use.
3. `delegate { task_id, executor: "subagent" }` — with subagents available a
   separate agent does the work (the default); `inline` only when you have
   none and do it yourself.
4. Do the work. Run the checks yourself as you go.
5. `submit_report { task_id, report }` with proof, not a summary: the
   commands you ran and their output, the files you changed, and a
   "Findings" section for what you noticed and left alone.
6. Record the tokens the work cost: `log_usage { project, task_id, role:
   "executor", source: "subagent", session: { client, id } }`. Pass the id
   the client gave you back and the server finds the tokens itself — you
   never copy numbers. Claude Code: client "claude-code", id is the agentId
   from the subagent's result. opencode: client "opencode", id is the
   ses_… from `<task id="…">` in the task result. Codex: client "codex", id
   is the task_name that spawn_agent returned (give each Codex subagent a
   unique task name with the journal task id in it, the newest file with
   that name wins) or a thread_id. Pass session alone: with numbers or
   usage_file next to it the call is refused. An executor started headlessly
   (`source: "headless"`): `claude -p --output-format json` — session
   { client: "claude-code", id: session_id from its output }; `codex exec
   --json` and `opencode run --format json` — usage_file is their output
   saved to a file (usage_file also takes a Claude Code transcript path
   when you have no id); text output has no numbers, so write nothing. A
   number from the result goes in as total_tokens only for a client that
   gives nothing but one sum for the whole work; Claude Code's
   subagent_tokens is the context size of the last turn, never write it.
   Any other client (Cursor and the rest): do not guess a client or a number,
   write nothing and say "токены: клиент не отдал"; the work goes on.
   Done `inline`: write nothing and say in the summary
   "токены не записаны: работа шла в этом чате". If the server has no `log_usage`, skip the step
   silently; if it refuses, say "токены: клиент не отдал".

A decision costly to undo (data model, library, protocol, module boundary)
is recorded on its own with `record_artifact { kind: "adr", task_id }`, in
the format the `actari` skill gives. Work found along the way becomes a new
`draft_task` plus `link_tasks { from_task_id, to_task_id, kind:
"discovered_from" }`, not part of this task.

A report is a claim ("REPORTED"), not a fact. Never write that a task is
done before step 5 accepts it.

## 5. Acceptance

**Never accept your own work.** The one who wrote the code does not give the
verdict.

With subagents available, start a separate subagent that has none of your
context. Give it only: the `task_id`, the acceptance criteria, and the
commands that check them. It reads the report with `get_task { task_id,
full: true }` and the diff, runs the checks itself, and answers in a fixed
form:

```
verdict: accept | rework | failed
evidence: <commands run and their result>
findings: <what is wrong or doubtful, one per line>
```

Record the verdict word for word:
`record_artifact { project, kind: "note", task_id, title: "acceptance: <task_id>", body }`.

Record the acceptor's tokens the same way: `log_usage { project, task_id,
role: "acceptance", source: "subagent", session: { client, id } }` with the id
of the acceptor subagent from step 6 (a forked skill returns no agentId: then
usage_file with its transcript, the one that has the task id in its first
line).

Then act on it:

- `accept` — if the task has an intent, call `intent_status` first; if a
  person cancelled, closed or took back the intent, stop and tell them.
  Otherwise `accept { task_id, evidence }` with the verdict's evidence.
- `rework` — `request_rework { task_id, reason }` with the findings, then
  `delegate` again and repeat step 4 for this task, and ask for a new
  verdict from a fresh subagent.
- `failed` — `mark_failed { task_id, reason }` and ask the person what to do.
- A second `rework` or `failed` on the same task: `mark_failed`, tell the
  person what is stuck and ask. Do not loop a third time.

Without subagents (other clients), show the person the report and the
evidence and ask for their verdict. Call `accept` only after the human says
ok, and record what they said with the same `acceptance: <task_id>` artifact.
If they say no, `request_rework` with their reasons.
No acceptor ran, so there is nothing to record with `role: "acceptance"`.

Self-acceptance in any other form — accepting because your own run passed,
or calling a subagent that shares your context a "reviewer" — is not
acceptance.

## 6. Summary

When every task is accepted, tell the person in a few lines:

- **Done** — what now works, in terms of the criteria they confirmed.
- **Checked by** — who gave the verdict and which commands proved it.
- **Tokens** — what `log_usage` recorded per role, or the line from step 6
  of section 4 when it recorded nothing.
- **Left** — findings and doubts; each one is also a `draft_task` draft so
  it is not lost.
- **Where to look** — the feature and its tasks on the cloud board, or "only
  in the local journal" if the cloud steps were skipped.

Then stop. Do not push, deploy or publish: that is the person's call.

## 7. Release

When the person says "shipped" / "выкатил", the changes are on prod. Record
it: `record_release { project, items: ["<slug>"], ref, notes }` where `ref`
is the commit or tag that went out (`git rev-parse HEAD` if they do not say),
and `notes` has one entry per item: `{ item: "<slug>", title, note }` — a
title a user would recognise and one phrase about what changed for them.

With the cloud connected, call `sync` right after so the release is pushed
and the notification goes out. Without it, tell the person the release is
recorded in the local journal only.
