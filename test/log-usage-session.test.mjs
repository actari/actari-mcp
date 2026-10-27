// log_usage { session } (спека ai-token-usage §8): сервер сам находит токены по
// id сессии Claude Code, opencode и Codex. Каталоги клиентов — только временные,
// через CLAUDE_CONFIG_DIR / XDG_DATA_HOME / CODEX_HOME; реальные ~/.claude,
// ~/.codex, ~/.local/share/opencode тест не читает.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { findUsageBySession } from "../usage-session.mjs";
import { parseUsageFile } from "../usage-file.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");
const FIXTURES = join(ROOT, "test", "fixtures", "usage");
const fixture = (name) => join(FIXTURES, name);

const PROJECT = "demo";
const TASK = "demo/2026-10-25-session";
const base = { project: PROJECT, task_id: TASK, role: "executor", source: "subagent" };

// Временные «домашние» каталоги клиентов; возвращает env для сервера.
function clientDirs() {
	const root = mkdtempSync(join(tmpdir(), "actari-session-"));
	const dirs = {
		root,
		claude: join(root, "claude"),
		xdg: join(root, "xdg"),
		codex: join(root, "codex"),
	};
	for (const d of [dirs.claude, dirs.xdg, dirs.codex]) mkdirSync(d, { recursive: true });
	dirs.env = {
		CLAUDE_CONFIG_DIR: dirs.claude,
		XDG_DATA_HOME: dirs.xdg,
		CODEX_HOME: dirs.codex,
		HOME: root,
	};
	return dirs;
}

function placeFile(path, from) {
	mkdirSync(dirname(path), { recursive: true });
	copyFileSync(from, path);
	return path;
}

function startClient(t, extraEnv) {
	const dir = mkdtempSync(join(tmpdir(), "actari-log-usage-session-"));
	const dbPath = join(dir, "journal.db");
	const env = { ...process.env, ...extraEnv, ACTARI_DB: dbPath };
	for (const k of Object.keys(env)) if (k.startsWith("ACTARI_") && k !== "ACTARI_DB") delete env[k];
	const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
	t.after(() => child.kill());
	let buf = "";
	const pending = new Map();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buf += chunk;
		for (;;) {
			const nl = buf.indexOf("\n");
			if (nl === -1) break;
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
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
	const tool = async (name, args) => {
		const msg = await call("tools/call", { name, arguments: args });
		const text = msg.result.content[0].text;
		return msg.result.isError ? { ok: false, error: text } : { ok: true, data: JSON.parse(text) };
	};
	const rawEvents = () => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return db
				.prepare("SELECT payload FROM events WHERE type = 'UsageRecorded' ORDER BY seq")
				.all()
				.map((row) => row.payload);
		} finally {
			db.close();
		}
	};
	const usageEvents = () => rawEvents().map((p) => JSON.parse(p));
	return { tool, usageEvents, rawEvents };
}

async function delegated(c) {
	await c.tool("register_project", { name: PROJECT, root_path: "/tmp/demo" });
	const d = await c.tool("draft_task", {
		task_id: TASK,
		project: PROJECT,
		title: "Работа",
		task_text: "текст",
	});
	assert.ok(d.ok, d.error);
	const r = await c.tool("delegate", { task_id: TASK, executor: "subagent" });
	assert.ok(r.ok, r.error);
}

function makeOpencodeDb(dirs, rows) {
	const path = join(dirs.xdg, "opencode", "opencode.db");
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE session (
		id TEXT PRIMARY KEY, parent_id TEXT, model TEXT, cost REAL,
		tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
		tokens_cache_read INTEGER, tokens_cache_write INTEGER
	)`);
	const ins = db.prepare(
		"INSERT INTO session (id, parent_id, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?,?,?,?,?,?,?,?,?)",
	);
	for (const r of rows) {
		ins.run(
			r.id,
			r.parent_id ?? null,
			r.model ?? null,
			r.cost ?? 0,
			r.input ?? 0,
			r.output ?? 0,
			r.reasoning ?? 0,
			r.cache_read ?? 0,
			r.cache_write ?? 0,
		);
	}
	db.close();
	return path;
}

const OPENCODE_ROW = {
	id: "ses_2f4a9c1d3ffeAbCdEf12345678",
	parent_id: "ses_parent0000000000000000",
	model: JSON.stringify({ id: "deepseek-v4-flash", providerID: "opencode-go", variant: null }),
	cost: 0.0123,
	input: 1200,
	output: 300,
	reasoning: 80,
	cache_read: 5000,
	cache_write: 40,
};

// ---------- Claude Code ----------

test("claude-code по agentId — находит subagents/agent-<id>.jsonl", async (t) => {
	const dirs = clientDirs();
	placeFile(
		join(dirs.claude, "projects", "-work-demo", "sess-1", "subagents", "agent-a1b2c3d4e5f6.jsonl"),
		fixture("claude-transcript.jsonl"),
	);
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		session: { client: "claude-code", id: "a1b2c3d4e5f6" },
	});
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents();
	assert.equal(event.input_tokens, 18);
	assert.equal(event.output_tokens, 180);
	assert.equal(event.cache_read_tokens, 6000);
	assert.equal(event.cache_write_tokens, 300);
	assert.equal(event.total_tokens, 6498);
	assert.equal(event.model, "claude-sonnet-5");
	assert.equal(event.usage_format, "claude-transcript");
});

test("claude-code по session_id — projects/<проект>/<id>.jsonl", async (t) => {
	const dirs = clientDirs();
	placeFile(
		join(dirs.claude, "projects", "-work-demo", "8c1f2a3b-0000-4000-8000-000000000009.jsonl"),
		fixture("claude-transcript.jsonl"),
	);
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		session: { client: "claude-code", id: "8c1f2a3b-0000-4000-8000-000000000009" },
	});
	assert.ok(r.ok, r.error);
	assert.equal(c.usageEvents()[0].total_tokens, 6498);
});

test("claude-code: два файла с одним id — отказ, событие не пишется", async (t) => {
	const dirs = clientDirs();
	for (const project of ["-work-a", "-work-b"]) {
		placeFile(
			join(dirs.claude, "projects", project, "sess", "subagents", "agent-dupdup.jsonl"),
			fixture("claude-transcript.jsonl"),
		);
	}
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		session: { client: "claude-code", id: "dupdup" },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /несколько|неоднозначн/);
	assert.match(r.error, /токены не записаны/);
	assert.equal(c.usageEvents().length, 0);
});

test("claude-code: нет файла — отказ с причиной", async (t) => {
	const dirs = clientDirs();
	mkdirSync(join(dirs.claude, "projects"), { recursive: true });
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		session: { client: "claude-code", id: "nope123" },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /не найден/);
	assert.match(r.error, /токены не записаны/);
	assert.equal(c.usageEvents().length, 0);
});

test("claude-code: id с разделителями пути не принимается", async (t) => {
	const dirs = clientDirs();
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		session: { client: "claude-code", id: "../../etc/passwd" },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /id/);
	assert.equal(c.usageEvents().length, 0);
});

// ---------- opencode ----------

test("opencode по ses_id — суммы из таблицы session, reasoning в output, cost и model", async (t) => {
	const dirs = clientDirs();
	makeOpencodeDb(dirs, [OPENCODE_ROW, { id: "ses_other", input: 1 }]);
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		session: { client: "opencode", id: OPENCODE_ROW.id },
	});
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents();
	assert.equal(event.input_tokens, 1200);
	assert.equal(event.output_tokens, 380);
	assert.equal(event.cache_read_tokens, 5000);
	assert.equal(event.cache_write_tokens, 40);
	assert.equal(event.total_tokens, 6620);
	assert.equal(event.cost_usd, 0.0123);
	assert.equal(event.model, "deepseek-v4-flash");
	assert.equal(event.usage_format, "opencode-session");
});

test("opencode: нет строки, нулевые токены, нет базы — отказ", async (t) => {
	const dirs = clientDirs();
	const c = startClient(t, dirs.env);
	await delegated(c);
	// базы нет вовсе
	let r = await c.tool("log_usage", { ...base, session: { client: "opencode", id: "ses_zero" } });
	assert.equal(r.ok, false);
	assert.match(r.error, /база opencode не найдена/);
	makeOpencodeDb(dirs, [{ id: "ses_zero" }]);
	r = await c.tool("log_usage", { ...base, session: { client: "opencode", id: "ses_missing" } });
	assert.equal(r.ok, false);
	assert.match(r.error, /не найдена|не найден/);
	r = await c.tool("log_usage", { ...base, session: { client: "opencode", id: "ses_zero" } });
	assert.equal(r.ok, false);
	assert.match(r.error, /нулев/);
	assert.equal(c.usageEvents().length, 0);
});

test("opencode: база не меняется (размер и mtime до и после)", () => {
	const dirs = clientDirs();
	const path = makeOpencodeDb(dirs, [OPENCODE_ROW]);
	utimesSync(path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
	const before = statSync(path);
	const bytesBefore = readFileSync(path);
	const result = findUsageBySession({ client: "opencode", id: OPENCODE_ROW.id }, dirs.env);
	assert.equal(result.format, "opencode-session");
	const after = statSync(path);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
	assert.ok(readFileSync(path).equals(bytesBefore));
});

// ---------- Codex ----------

const THREAD = "019a0000-0000-7000-8000-000000000001";
const SUB_THREAD = "019a0000-0000-7000-8000-000000000002";
const TASK_NAME = "/root/review_inspection_validation";

function codexPath(dirs, id, stamp = "2026-10-25T10-00-00", day = "2026/10/25") {
	return join(dirs.codex, "sessions", day, `rollout-${stamp}-${id}.jsonl`);
}

test("codex по thread_id — последний token_count, input без cached", async (t) => {
	const dirs = clientDirs();
	placeFile(codexPath(dirs, THREAD), fixture("codex-rollout.jsonl"));
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", { ...base, session: { client: "codex", id: THREAD } });
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents();
	assert.equal(event.input_tokens, 600);
	assert.equal(event.cache_read_tokens, 2400);
	assert.equal(event.cache_write_tokens, 0);
	assert.equal(event.output_tokens, 200);
	assert.equal(event.total_tokens, 3200);
	assert.equal(event.model, "gpt-5.5");
	assert.equal(event.usage_format, "codex-rollout");
});

test("codex по task_name — новейший rollout с agent_path", async (t) => {
	const dirs = clientDirs();
	// старый файл с тем же именем задачи и другими числами
	const older = readFileSync(fixture("codex-subagent-rollout.jsonl"), "utf8")
		.replace(SUB_THREAD, "019a0000-0000-7000-8000-0000000000aa")
		.replace(/"total_tokens":5300/g, '"total_tokens":999')
		.replace(/"input_tokens":5000/g, '"input_tokens":900');
	mkdirSync(dirname(codexPath(dirs, "x", "2026-10-24T09-00-00", "2026/10/24")), {
		recursive: true,
	});
	writeFileSync(
		codexPath(dirs, "019a0000-0000-7000-8000-0000000000aa", "2026-10-24T09-00-00", "2026/10/24"),
		older,
	);
	placeFile(codexPath(dirs, SUB_THREAD), fixture("codex-subagent-rollout.jsonl"));
	// посторонний rollout без agent_path не мешает
	placeFile(codexPath(dirs, THREAD, "2026-10-25T11-00-00"), fixture("codex-rollout.jsonl"));
	const c = startClient(t, dirs.env);
	await delegated(c);
	const r = await c.tool("log_usage", { ...base, session: { client: "codex", id: TASK_NAME } });
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents();
	assert.equal(event.input_tokens, 1000);
	assert.equal(event.cache_read_tokens, 4000);
	assert.equal(event.output_tokens, 300);
	assert.equal(event.total_tokens, 5300);
	assert.equal(event.model, "gpt-5.5-mini");
	assert.equal(event.usage_format, "codex-rollout");
});

test("codex: task_name без совпадений и thread_id без файла — отказ", async (t) => {
	const dirs = clientDirs();
	placeFile(codexPath(dirs, THREAD), fixture("codex-rollout.jsonl"));
	const c = startClient(t, dirs.env);
	await delegated(c);
	let r = await c.tool("log_usage", {
		...base,
		session: { client: "codex", id: "/root/no_such_task" },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /не найден/);
	r = await c.tool("log_usage", {
		...base,
		session: { client: "codex", id: "019a0000-0000-7000-8000-00000000ffff" },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /не найден/);
	assert.equal(c.usageEvents().length, 0);
});

test("codex: rollout без token_count — отказ", () => {
	const dirs = clientDirs();
	const p = codexPath(dirs, THREAD);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(
		p,
		`${JSON.stringify({ type: "session_meta", payload: { id: THREAD, source: "exec" } })}\n`,
	);
	assert.throws(
		() => findUsageBySession({ client: "codex", id: THREAD }, dirs.env),
		/token_count|токен/,
	);
});

// ---------- usage_file: codex exec --json ----------

test("usage_file: codex exec --json — сумма turn.completed", async (t) => {
	const c = startClient(t, clientDirs().env);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		source: "headless",
		usage_file: fixture("codex-exec.jsonl"),
	});
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents();
	assert.equal(event.input_tokens, 8489);
	assert.equal(event.cache_read_tokens, 27736);
	assert.equal(event.cache_write_tokens, 50);
	assert.equal(event.output_tokens, 200);
	assert.equal(event.total_tokens, 36475);
	assert.equal(event.usage_format, "codex-json");
});

test("parseUsageFile: codex-json распознаётся и не путается с другими форматами", () => {
	const parsed = parseUsageFile(fixture("codex-exec.jsonl"));
	assert.equal(parsed.format, "codex-json");
	assert.equal(parsed.output_tokens, 200);
});

// ---------- общие правила ----------

test("session вместе с usage_file или числами — отказ", async (t) => {
	const dirs = clientDirs();
	placeFile(codexPath(dirs, THREAD), fixture("codex-rollout.jsonl"));
	const c = startClient(t, dirs.env);
	await delegated(c);
	const session = { client: "codex", id: THREAD };
	for (const extra of [
		{ usage_file: fixture("codex-exec.jsonl") },
		{ total_tokens: 10 },
		{ input_tokens: 1 },
		{ cost_usd: 0.1 },
	]) {
		const r = await c.tool("log_usage", { ...base, session, ...extra });
		assert.equal(r.ok, false, JSON.stringify(extra));
		assert.match(r.error, /один источник|вместе/);
	}
	assert.equal(c.usageEvents().length, 0);
});

test("неизвестный client и неполный session — отказ", async (t) => {
	const c = startClient(t, clientDirs().env);
	await delegated(c);
	for (const session of [
		{ client: "cursor", id: "abc" },
		{ client: "codex" },
		{ id: "abc" },
		{ client: "codex", id: "" },
	]) {
		const r = await c.tool("log_usage", { ...base, session });
		assert.equal(r.ok, false, JSON.stringify(session));
		assert.match(r.error, /session|client|id/);
	}
	assert.equal(c.usageEvents().length, 0);
});

test("payload UsageRecorded без путей и id", async (t) => {
	const dirs = clientDirs();
	placeFile(codexPath(dirs, THREAD), fixture("codex-rollout.jsonl"));
	placeFile(
		join(dirs.claude, "projects", "-work-demo", "sess-1", "subagents", "agent-zzz999.jsonl"),
		fixture("claude-transcript.jsonl"),
	);
	makeOpencodeDb(dirs, [OPENCODE_ROW]);
	const c = startClient(t, dirs.env);
	await delegated(c);
	for (const session of [
		{ client: "codex", id: THREAD },
		{ client: "claude-code", id: "zzz999" },
		{ client: "opencode", id: OPENCODE_ROW.id },
	]) {
		const r = await c.tool("log_usage", { ...base, session });
		assert.ok(r.ok, r.error);
	}
	const raw = c.rawEvents();
	assert.equal(raw.length, 3);
	for (const text of raw) {
		assert.ok(!text.includes(THREAD), text);
		assert.ok(!text.includes("zzz999"), text);
		assert.ok(!text.includes("ses_"), text);
		assert.ok(!text.includes(dirs.root), text);
		assert.ok(!/"session"|"usage_file"|\.jsonl/.test(text), text);
	}
});
