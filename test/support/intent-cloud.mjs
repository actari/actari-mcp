// Мок облака по контракту плана 1 (journal-sync, journal-inbox, intents)
// с изменяемым состоянием намерений и клиент MCP поверх спавна server.mjs.
// Сеть — только 127.0.0.1 с портом от ОС.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { localDay } from "./local-day.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const SCHEMA = join(ROOT, "schema.sql");
export const SERVER = join(ROOT, "server.mjs");

export const TOKEN = "test-mcp-token";
export const JOURNAL = "journal-intent";
export const WS = { id: "ws-alpha", slug: "alpha-space", name: "Alpha" };
export const OTHER_WS = { id: "ws-other", slug: "other-space", name: "Other" };
export const ME = { id: "u-me", name: "Алексей" };
export const LEAD = { id: "u-lead", name: "Лид" };

// Дата задачи журнала: сервер собирает id из ЛОКАЛЬНОЙ даты (today() в
// server.mjs) — так же строит её общий тестовый хелпер localDay().
export function today() {
	return localDay();
}

export function cleanEnv(extra = {}) {
	const env = { ...process.env };
	for (const key of [
		"ACTARI_SYNC_URL",
		"ACTARI_SYNC_TOKEN",
		"ACTARI_SYNC_JOURNAL_ID",
		"ACTARI_SYNC_CONFIG",
		"ACTARI_SYNC_PROJECTS",
		"ACTARI_DB",
		"ACTARI_INTENT_POLL_MS",
		"ACTARI_INTENT_TIMEOUT_MS",
		"ACTARI_INBOX_TIMEOUT_MS",
		"ACTARI_CHANGES_PAGE",
	]) {
		delete env[key];
	}
	return { ...env, ...extra };
}

export function mcpEnv(dir, baseUrl, extra = {}) {
	return cleanEnv({
		ACTARI_DB: join(dir, "journal.db"),
		ACTARI_SCHEMA: SCHEMA,
		ACTARI_SYNC_URL: baseUrl,
		ACTARI_SYNC_TOKEN: TOKEN,
		ACTARI_SYNC_JOURNAL_ID: JOURNAL,
		// По умолчанию опрос редкий — тесты фонового опроса ставят свой.
		ACTARI_INTENT_POLL_MS: "3600000",
		ACTARI_INTENT_TIMEOUT_MS: "1000",
		...extra,
	});
}

export async function waitFor(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

export function startMcp(t, env) {
	const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => child.kill());
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => (stderr += chunk));

	let buffer = "";
	const pending = new Map();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		while (true) {
			const nl = buffer.indexOf("\n");
			if (nl === -1) break;
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			const msg = JSON.parse(line);
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
		}
	});

	let seq = 0;
	const call = (method, params) =>
		new Promise((resolve) => {
			const id = ++seq;
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	// Ответ — массив content: первый блок — результат инструмента (JSON или
	// текст), второй, если есть, — уведомления. text склеивает все блоки,
	// data — только разбор первого: уведомления не имеют права портить JSON.
	const tool = async (name, args = {}) => {
		const msg = await call("tools/call", { name, arguments: args });
		const parts = msg.result.content.map((part) => part.text);
		const text = parts.join("\n\n");
		if (msg.result.isError) return { ok: false, text, parts };
		try {
			return { ok: true, data: JSON.parse(parts[0]), text, parts };
		} catch {
			return { ok: true, text, parts };
		}
	};
	return { call, tool, getStderr: () => stderr };
}

// ============ облако ============

export function startIntentCloud(
	t,
	{
		workspaces = [WS],
		intents = [],
		intentsRoute = true,
		// id намерений, которых «нет в пространстве»: ingest отвечает warning
		missingIntentIds = [],
		hang = [],
		changesLimit = 100,
	} = {},
) {
	const state = {
		views: new Map(),
		cursor: 0,
		seen: new Set(),
		clock: new Date(),
		down: false,
		takes: [],
		releases: [],
		intentGets: 0,
		changesQueries: [],
		releaseOverride: null,
		publishes: [],
		publishOverride: null,
		published: new Map(),
	};

	// Реальные часы плюс монотонность: если Date.now() не вырос, +1 мс.
	const tick = () => {
		const now = new Date();
		state.clock =
			now.getTime() <= state.clock.getTime() ? new Date(state.clock.getTime() + 1) : now;
		return state.clock.toISOString();
	};

	const derive = (view) => {
		if (view.override?.kind === "CANCELLED") return "cancelled";
		if (view.override?.kind === "DONE_MANUAL") return "done_manual";
		return view.intentState === "TAKEN" ? "taken" : "proposed";
	};

	const touch = (view, kind, by, note = null) => {
		const at = tick();
		view.intentUpdatedAt = at;
		view.lastIntervention = { kind, note, by, at };
		view.derived = { state: derive(view), journal: null, attempts: 0 };
		return at;
	};

	const addIntent = (id, over = {}) => {
		const at = tick();
		const view = {
			id,
			title: `Намерение ${id}`,
			workspace: { id: WS.id, slug: WS.slug },
			feature: { id: "f-1", title: "Прогноз", status: "IN_PROGRESS" },
			intentState: "PROPOSED",
			override: null,
			derived: { state: "proposed", journal: null, attempts: 0 },
			assignee: null,
			takenBy: null,
			isMine: false,
			reopenedAt: null,
			priority: "NONE",
			acceptanceCriteria: "- отдаёт 7 дней",
			criteriaVersion: 1,
			intentUpdatedAt: at,
			lastIntervention: null,
			...over,
		};
		state.views.set(id, view);
		return view;
	};
	for (const intent of intents) addIntent(intent.id, intent);

	const get = (id) => {
		const view = state.views.get(id);
		if (!view) throw new Error(`мок: нет намерения ${id}`);
		return view;
	};

	const helpers = {
		addIntent,
		cancel(id, note = "фича снята") {
			const view = get(id);
			view.override = { kind: "CANCELLED", note, by: LEAD, at: tick() };
			touch(view, "CANCEL", LEAD, note);
		},
		closeManually(id, note = "сделали руками") {
			const view = get(id);
			view.override = { kind: "DONE_MANUAL", note, by: LEAD, at: tick() };
			touch(view, "DONE_MANUAL", LEAD, note);
		},
		returnToInbox(id, note = "переделать") {
			const view = get(id);
			Object.assign(view, {
				intentState: "PROPOSED",
				takenBy: null,
				isMine: false,
				override: null,
				reopenedAt: tick(),
			});
			touch(view, "RETURN_TO_INBOX", LEAD, note);
		},
		giveTo(id, person) {
			const view = get(id);
			Object.assign(view, {
				intentState: "TAKEN",
				takenBy: person,
				assignee: person,
				isMine: false,
				reopenedAt: tick(),
			});
			touch(view, "ASSIGNEE_CHANGED", LEAD);
		},
		changeCriteria(id, text) {
			const view = get(id);
			view.acceptanceCriteria = text;
			view.criteriaVersion += 1;
			touch(view, "CRITERIA_CHANGED", LEAD);
		},
		setPriority(id, priority) {
			const view = get(id);
			view.priority = priority;
			touch(view, "PRIORITY_CHANGED", LEAD);
		},
	};

	const inboxItem = (view) => ({
		id: view.id,
		title: view.title,
		description: null,
		priority: view.priority,
		acceptanceCriteria: view.acceptanceCriteria,
		criteriaVersion: view.criteriaVersion,
		assignee: view.assignee,
		isMine: view.assignee?.id === ME.id,
		feature: { id: view.feature.id, title: view.feature.title },
		workspace: { ...view.workspace, name: "Alpha" },
		createdAt: view.intentUpdatedAt,
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const send = (code, body) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.headers.authorization !== `Bearer ${TOKEN}`) {
			return send(401, { error: "Invalid or revoked MCP token" });
		}
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : {};
			const path = url.pathname;

			if (path.endsWith("/journal-policy")) {
				return send(200, {
					workspaces: workspaces.map((ws) => ({
						id: ws.id,
						slug: ws.slug,
						policyId: null,
						version: null,
						body: null,
					})),
				});
			}
			if (path.endsWith("/journal-sync")) {
				if (req.method === "GET") {
					if (hang.includes("cursor")) return;
					return send(200, {
						workspaces: workspaces.map((ws) => ({ ...ws, lastSeq: state.cursor })),
					});
				}
				const warnings = [];
				for (const event of body.events ?? []) {
					if (state.seen.has(event.seq)) continue;
					state.seen.add(event.seq);
					state.cursor = Math.max(state.cursor, event.seq);
					const intentId = event.payload?.intent_task_id;
					if (event.type === "TaskDrafted" && missingIntentIds.includes(intentId)) {
						warnings.push({ seq: event.seq, code: "intent_not_found", intentTaskId: intentId });
					}
				}
				return send(200, {
					applied: body.events?.length ?? 0,
					skipped: 0,
					lastSeq: state.cursor,
					warnings,
				});
			}

			if (state.down) return send(503, { error: "maintenance" });

			if (path.endsWith("/journal-inbox")) {
				if (req.method === "GET") {
					if (hang.includes("inbox")) return;
					const items = [...state.views.values()].filter(
						(view) => view.intentState === "PROPOSED" && !view.override,
					);
					return send(200, { items: items.map(inboxItem) });
				}
				state.takes.push(body.taskId);
				const view = state.views.get(body.taskId);
				if (!view) return send(404, { error: "Intent not found" });
				if (view.override) {
					return send(409, {
						reason: "overridden",
						override: view.override.kind,
						note: view.override.note,
						by: view.override.by,
						at: view.override.at,
						intent: view,
					});
				}
				if (view.intentState === "TAKEN" && !view.isMine) {
					return send(409, {
						reason: "taken_by_other",
						by: view.takenBy,
						at: view.lastIntervention?.at ?? view.intentUpdatedAt,
						intent: view,
					});
				}
				const alreadyTaken = view.intentState === "TAKEN";
				if (!alreadyTaken) {
					Object.assign(view, {
						intentState: "TAKEN",
						takenBy: ME,
						assignee: view.assignee ?? ME,
						isMine: true,
					});
					touch(view, "TAKE", ME);
				}
				return send(200, {
					taken: true,
					alreadyTaken,
					context: {
						...inboxItem(view),
						isMine: true,
						feature: {
							id: view.feature.id,
							title: view.feature.title,
							description: "Погода на неделю",
							clarifications: null,
						},
						recommendedSlug: `intent-${view.id}`,
					},
					intent: view,
				});
			}

			if (path.includes("/api/mcp/intents")) {
				if (!intentsRoute) return send(404, { error: "Unknown endpoint" });
				if (req.method === "POST" && path.endsWith("/api/mcp/intents")) {
					state.publishes.push(body);
					if (state.publishOverride) {
						const over = state.publishOverride;
						state.publishOverride = null;
						if (over.status === 403) return send(403, { error: "Not a member of this workspace" });
						return send(over.status ?? 409, { reason: over.reason, intent: over.intent ?? null });
					}
					const key = `${body.workspaceId}/${body.project}/${body.slug}`;
					const reply = (outcome, view) =>
						send(200, {
							outcome,
							intentId: view.id,
							featureId: view.feature.id,
							criteriaVersion: view.criteriaVersion,
							intent: view,
						});
					if (body.intentTaskId) {
						const view = state.views.get(body.intentTaskId);
						if (!view) return send(404, { error: "Intent not found" });
						const had = state.published.get(key)?.id === view.id;
						state.published.set(key, { id: view.id, text: body.text });
						return reply(had ? "unchanged" : "bound", view);
					}
					const known = state.published.get(key);
					if (!known) {
						const n = state.published.size + 1;
						const view = addIntent(`intent-pub-${n}`, {
							title: body.title,
							acceptanceCriteria: body.acceptanceCriteria,
							feature: { id: `f-pub-${n}`, title: body.title, status: "IN_PROGRESS" },
						});
						state.published.set(key, { id: view.id, text: body.text });
						return reply("created", view);
					}
					const view = get(known.id);
					const criteriaChanged = view.acceptanceCriteria !== body.acceptanceCriteria;
					if (!criteriaChanged && known.text === body.text) return reply("unchanged", view);
					if (criteriaChanged) helpers.changeCriteria(view.id, body.acceptanceCriteria);
					known.text = body.text;
					return reply("updated", view);
				}
				if (path.endsWith("/intents/changes")) {
					const since = url.searchParams.get("since");
					state.changesQueries.push(since);
					const items = [...state.views.values()]
						.filter((view) => view.intentUpdatedAt > since)
						.sort((a, b) => a.intentUpdatedAt.localeCompare(b.intentUpdatedAt))
						.slice(0, changesLimit);
					return send(200, { items, serverTime: state.clock.toISOString() });
				}
				const parts = path.split("/");
				const isRelease = parts.at(-1) === "release";
				const id = decodeURIComponent(isRelease ? parts.at(-2) : parts.at(-1));
				const view = state.views.get(id);
				if (!view) return send(404, { error: "Intent not found" });
				if (!isRelease) {
					state.intentGets += 1;
					return send(200, view);
				}
				state.releases.push({ id, note: body.note ?? null });
				if (state.releaseOverride) {
					const over = state.releaseOverride;
					state.releaseOverride = null;
					if (over.status === 403) return send(403, { error: "Not a member of this workspace" });
					return send(over.status ?? 409, { reason: over.reason, intent: view });
				}
				if (!view.isMine) return send(409, { reason: "not_taken_by_you", intent: view });
				Object.assign(view, {
					intentState: "PROPOSED",
					takenBy: null,
					isMine: false,
					reopenedAt: tick(),
				});
				touch(view, "RELEASE", ME, body.note ?? null);
				return send(200, { changed: true, intent: view });
			}

			send(404, { error: "Unknown endpoint" });
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			t.after(() => {
				server.closeAllConnections();
				return new Promise((done) => server.close(done));
			});
			resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, state, ...helpers });
		});
	});
}
