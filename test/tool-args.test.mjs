// Юнит- и интеграционные тесты проверки аргументов tools/call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { checkToolArguments, formatToolArgumentsError } from "../tool-args.mjs";

const schema = {
	type: "object",
	properties: {
		task_id: { type: "string" },
		report: { type: "string" },
		limit: { type: "number" },
	},
	required: ["task_id", "report"],
};

test("checkToolArguments: нет обязательного поля", () => {
	const r = checkToolArguments(schema, { task_id: "p/1", report_text: "x" });
	assert.deepEqual(r.missing, ["report"]);
	assert.deepEqual(r.unknown, ["report_text"]);
});

test("checkToolArguments: null считается отсутствием", () => {
	assert.deepEqual(checkToolArguments(schema, { task_id: "p/1", report: null }).missing, [
		"report",
	]);
});

test("checkToolArguments: неверный тип", () => {
	const r = checkToolArguments(schema, { task_id: "p/1", report: "ok", limit: "5" });
	assert.deepEqual(r.wrongType, [{ name: "limit", expected: "number" }]);
});

test("formatToolArgumentsError: перечисляет недостающие, неизвестные и допустимые", () => {
	const text = formatToolArgumentsError(
		"submit_report",
		schema,
		checkToolArguments(schema, { task_id: "p/1", report_text: "x" }),
	);
	for (const s of ["report", "report_text", "task_id", "limit"]) assert.match(text, new RegExp(s));
});

// --- Интеграция: настоящий сервер через stdio, временная база (копия startClient из server.test.mjs) ---

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");

function startClient(t, dbPathOverride) {
	const dir = mkdtempSync(join(tmpdir(), "actari-test-"));
	const dbPath = dbPathOverride ?? join(dir, "test.db");
	const child = spawn(process.execPath, [SERVER], {
		env: { ...process.env, ACTARI_DB: dbPath },
		stdio: ["pipe", "pipe", "inherit"],
	});
	t.after(() => child.kill());

	let buf = "";
	const pending = new Map();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buf += chunk;
		while (true) {
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
		return msg.result.isError
			? { ok: false, error: text, content: msg.result.content }
			: { ok: true, data: JSON.parse(text), content: msg.result.content };
	};

	return { call, tool, dbPath };
}

async function reg(c, name) {
	await c.tool("register_project", { name, root_path: `/tmp/${name}` });
}

function countEvents(dbPath) {
	const db = new DatabaseSync(dbPath);
	try {
		return db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
	} finally {
		db.close();
	}
}

test("tools/call: submit_report с report_text вместо report — isError, событие не пишется", async (t) => {
	const c = startClient(t);
	await reg(c, "p");
	await c.tool("draft_task", { task_id: "p/1", project: "p", title: "т", task_text: "текст" });
	await c.tool("delegate", { task_id: "p/1", executor: "grok" });

	const before = countEvents(c.dbPath);
	const res = await c.tool("submit_report", { task_id: "p/1", report_text: "x" });
	assert.equal(res.ok, false);
	assert.match(res.error, /report_text/);
	assert.match(res.error, /report/);
	assert.equal(countEvents(c.dbPath), before, "новое событие не должно появиться");

	const status = await c.tool("get_task", { task_id: "p/1" });
	assert.equal(status.data.task.status, "DELEGATED");
});

test("tools/call: submit_report без report — isError, событий не прибавилось", async (t) => {
	const c = startClient(t);
	await reg(c, "p");
	await c.tool("draft_task", { task_id: "p/1", project: "p", title: "т", task_text: "текст" });
	await c.tool("delegate", { task_id: "p/1", executor: "grok" });

	const before = countEvents(c.dbPath);
	const res = await c.tool("submit_report", { task_id: "p/1" });
	assert.equal(res.ok, false);
	assert.equal(countEvents(c.dbPath), before);
});

test("tools/call: list_tasks с limit строкой — isError с подсказкой о типе", async (t) => {
	const c = startClient(t);
	const res = await c.tool("list_tasks", { limit: "5" });
	assert.equal(res.ok, false);
	assert.match(res.error, /limit \(ожидается number\)/);
});

test("tools/call: list_tasks с лишним полем — успех, подсказка отдельным элементом content", async (t) => {
	const c = startClient(t);
	const res = await c.tool("list_tasks", { limit: 5, bogus: 1 });
	assert.equal(res.ok, true);
	assert.equal(
		res.content.length,
		2,
		"подсказка — отдельный элемент content, content[0] остаётся JSON",
	);
	assert.match(res.content[1].text, /bogus/);
});
