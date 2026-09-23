// Тесты компактного get_task и эха актов журнала (T4).
// Запуск: pnpm --filter actari-mcp test (или node --test test/ из apps/mcp)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // ~/.actari
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

	// tools/call → {ok:true, data} либо {ok:false, error}
	const tool = async (name, args) => {
		const msg = await call("tools/call", { name, arguments: args });
		const text = msg.result.content[0].text;
		return msg.result.isError ? { ok: false, error: text } : { ok: true, data: JSON.parse(text) };
	};

	return { call, tool, dbPath };
}

test("get_task: компактный ответ ≤ 2 КБ без задания и отчёта, full — прежний вид", async (t) => {
	const c = startClient(t);
	await c.call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "t", version: "0" },
	});
	const big = "x".repeat(20_000);
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo" });
	const drafted = await c.tool("draft_task", {
		project: "demo",
		slug: "big",
		title: "Большая",
		task_text: big,
	});
	const taskId = drafted.data.task_id;
	await c.tool("delegate", { task_id: taskId, executor: "subagent" });
	await c.tool("submit_report", { task_id: taskId, report: big });

	const compact = await c.tool("get_task", { task_id: taskId });
	assert.ok(
		JSON.stringify(compact.data).length <= 2048,
		`компактный ответ ${JSON.stringify(compact.data).length} байт`,
	);
	assert.equal(compact.data.task.task_text, undefined);
	assert.equal(compact.data.task.report_text, undefined);
	assert.equal(compact.data.task.task_text_length, 20_000);
	assert.equal(compact.data.task.report_length, 20_000);
	assert.equal(compact.data.task.has_report, true);
	assert.deepEqual(Object.keys(compact.data.events[0]).sort(), ["at", "seq", "type"]);

	const full = await c.tool("get_task", { task_id: taskId, full: true });
	assert.equal(full.data.task.task_text, big);
	assert.equal(full.data.task.report_text, big);
	assert.ok(full.data.events.every((e) => typeof e.payload === "string"));
});

test("акты возвращают компактную задачу: без задания и отчёта, с длинами", async (t) => {
	const c = startClient(t);
	await c.call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "t", version: "0" },
	});
	const big = "x".repeat(20_000);
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo" });
	const drafted = await c.tool("draft_task", {
		project: "demo",
		slug: "echo",
		title: "Эхо",
		task_text: big,
	});
	assert.equal(drafted.data.task_text, undefined);
	assert.equal(drafted.data.task_text_length, 20_000);
	const delegated = await c.tool("delegate", {
		task_id: drafted.data.task_id,
		executor: "subagent",
	});
	assert.equal(delegated.data.task_text, undefined);
	assert.equal(delegated.data.status, "DELEGATED");
	const reported = await c.tool("submit_report", { task_id: drafted.data.task_id, report: big });
	assert.equal(reported.data.report_text, undefined);
	assert.equal(reported.data.has_report, true);
	assert.equal(reported.data.report_length, 20_000);
	assert.ok(JSON.stringify(reported.data).length <= 1024);
});
