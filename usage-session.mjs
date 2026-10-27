// Поиск токенов по id сессии для log_usage { session } (спека ai-token-usage §8):
// агент знает только id, который клиент вернул в результате, а файл с токенами
// находит сервер журнала. Три клиента — три внутренних формата, не обещанный API:
// сломавшийся формат даёт отказ «токены не найдены», а не неверное число.
// Каталоги клиентов — из окружения (CLAUDE_CONFIG_DIR, XDG_DATA_HOME, CODEX_HOME),
// по умолчанию — домашние. Всё только на чтение.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { codexFields, parseUsageFile } from "./usage-file.mjs";

export const SESSION_CLIENTS = ["claude-code", "opencode", "codex"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function home(env) {
	return env.HOME || homedir();
}

function dirEntries(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

// ---------- Claude Code ----------

const CLAUDE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function findClaudeCode(id, env) {
	if (!CLAUDE_ID.test(id)) {
		throw new Error(
			"id сессии Claude Code — agentId или session_id: только буквы, цифры, «-» и «_»",
		);
	}
	const projects = join(env.CLAUDE_CONFIG_DIR || join(home(env), ".claude"), "projects");
	const matches = [];
	for (const project of dirEntries(projects)) {
		if (!project.isDirectory()) continue;
		const projectDir = join(projects, project.name);
		const session = join(projectDir, `${id}.jsonl`);
		if (existsSync(session)) matches.push(session);
		for (const sub of dirEntries(projectDir)) {
			if (!sub.isDirectory()) continue;
			const agent = join(projectDir, sub.name, "subagents", `agent-${id}.jsonl`);
			if (existsSync(agent)) matches.push(agent);
		}
	}
	if (matches.length === 0) {
		throw new Error(
			`транскрипт Claude Code для id «${id}» не найден в ${projects} (ищем subagents/agent-<id>.jsonl и <session_id>.jsonl)`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`для id «${id}» найдено несколько транскриптов Claude Code (${matches.length}): id неоднозначен`,
		);
	}
	return parseUsageFile(matches[0]);
}

// ---------- opencode ----------

const OPENCODE_ID = /^[A-Za-z0-9_-]+$/;

function findOpencode(id, env) {
	if (!OPENCODE_ID.test(id)) throw new Error("id сессии opencode — вида ses_…: буквы, цифры, «_»");
	const dbPath = join(
		env.XDG_DATA_HOME || join(home(env), ".local", "share"),
		"opencode",
		"opencode.db",
	);
	if (!existsSync(dbPath)) throw new Error(`база opencode не найдена: ${dbPath}`);
	let row;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			row = db
				.prepare(
					"SELECT model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?",
				)
				.get(id);
		} finally {
			db.close();
		}
	} catch (err) {
		throw new Error(`не удалось прочитать базу opencode (${err.message}): формат мог измениться`);
	}
	if (!row) throw new Error(`сессия opencode «${id}» не найдена в базе`);
	const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
	const parsed = {
		format: "opencode-session",
		input_tokens: n(row.tokens_input),
		// reasoning-токены тарифицируются как выход
		output_tokens: n(row.tokens_output) + n(row.tokens_reasoning),
		cache_read_tokens: n(row.tokens_cache_read),
		cache_write_tokens: n(row.tokens_cache_write),
	};
	const total =
		parsed.input_tokens +
		parsed.output_tokens +
		parsed.cache_read_tokens +
		parsed.cache_write_tokens;
	if (total === 0) throw new Error(`у сессии opencode «${id}» нулевой расход токенов`);
	if (typeof row.cost === "number" && row.cost > 0) {
		parsed.cost_usd = Math.round(row.cost * 1e6) / 1e6;
	}
	try {
		const model = JSON.parse(row.model)?.id;
		if (typeof model === "string" && model) parsed.model = model;
	} catch {
		// модель не обязательна
	}
	return parsed;
}

// ---------- Codex ----------

const CODEX_THREAD = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;
const CODEX_TASK_NAME = /^\/[A-Za-z0-9_./-]+$/;

// Все rollout-файлы, новейшие первыми: имя содержит время запуска, каталоги —
// YYYY/MM/DD, поэтому обратный лексикографический порядок пути — по убыванию времени.
function codexRollouts(sessionsDir) {
	const files = [];
	const walk = (dir) => {
		for (const entry of dirEntries(dir)) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
		}
	};
	walk(sessionsDir);
	return files.sort((a, b) => {
		const fa = a.slice(a.lastIndexOf("/") + 1);
		const fb = b.slice(b.lastIndexOf("/") + 1);
		return fa < fb ? 1 : fa > fb ? -1 : 0;
	});
}

// Первая строка файла (session_meta может весить десятки КБ).
function firstLine(path) {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(65536);
		let text = "";
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			text += chunk.toString("utf8", 0, read);
			const nl = text.indexOf("\n");
			if (nl !== -1) return text.slice(0, nl);
			if (text.length > 4 * 1024 * 1024) break;
		}
		return text;
	} finally {
		closeSync(fd);
	}
}

function agentPathOf(path) {
	try {
		const meta = JSON.parse(firstLine(path));
		const spawnInfo = meta?.payload?.source?.subagent?.thread_spawn;
		return isObject(spawnInfo) && typeof spawnInfo.agent_path === "string"
			? spawnInfo.agent_path
			: null;
	} catch {
		return null;
	}
}

function parseCodexRollout(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`не удалось прочитать rollout Codex: ${err.code ?? err.message}`);
	}
	let usage = null;
	let model = null;
	for (const line of text.split("\n")) {
		const hasCount = line.includes('"token_count"');
		const hasContext = line.includes('"turn_context"');
		if (!hasCount && !hasContext) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			row?.type === "event_msg" &&
			row.payload?.type === "token_count" &&
			isObject(row.payload.info?.total_token_usage)
		) {
			usage = row.payload.info.total_token_usage; // накопленный итог — нужен последний
		} else if (row?.type === "turn_context" && typeof row.payload?.model === "string") {
			model = row.payload.model;
		}
	}
	if (!usage) throw new Error("в rollout Codex нет событий token_count с накопленным итогом");
	const fields = codexFields(usage);
	const sum =
		fields.input_tokens +
		fields.output_tokens +
		fields.cache_read_tokens +
		fields.cache_write_tokens;
	if (sum === 0) throw new Error("в rollout Codex нулевой расход токенов");
	const parsed = { format: "codex-rollout", ...fields };
	if (Number.isInteger(usage.total_tokens) && usage.total_tokens > 0) {
		parsed.total_tokens = usage.total_tokens;
	}
	if (model) parsed.model = model;
	return parsed;
}

function findCodex(id, env) {
	const sessions = join(env.CODEX_HOME || join(home(env), ".codex"), "sessions");
	const byTaskName = id.startsWith("/");
	if (byTaskName ? !CODEX_TASK_NAME.test(id) : !CODEX_THREAD.test(id)) {
		throw new Error("id сессии Codex — thread_id (UUID) или task_name субагента вида /root/имя");
	}
	const files = codexRollouts(sessions);
	let found;
	if (byTaskName) {
		found = files.find((file) => agentPathOf(file) === id); // новейший
	} else {
		found = files.find((file) => file.endsWith(`-${id}.jsonl`));
	}
	if (!found) {
		throw new Error(
			`rollout Codex для «${id}» не найден в ${sessions}${byTaskName ? " (ищем по agent_path субагента)" : ""}`,
		);
	}
	return parseCodexRollout(found);
}

// ---------- вход ----------

export function findUsageBySession(session, env = process.env) {
	if (!isObject(session)) throw new Error("session — объект { client, id }");
	const { client, id } = session;
	if (!SESSION_CLIENTS.includes(client)) {
		throw new Error(`session.client: ${SESSION_CLIENTS.join(" | ")}`);
	}
	if (typeof id !== "string" || id.trim() === "") throw new Error("session.id — непустая строка");
	const trimmed = id.trim();
	if (client === "claude-code") return findClaudeCode(trimmed, env);
	if (client === "opencode") return findOpencode(trimmed, env);
	return findCodex(trimmed, env);
}
