// Тесты компактных инцидентов в search_precedents, полный вид по full: true (T6).
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

test("search_precedents: инциденты компактные (280 символов), полный вид по full: true", async (t) => {
	const c = startClient(t);
	await c.call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "t", version: "0" },
	});
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo" });
	const drafted = await c.tool("draft_task", {
		project: "demo",
		slug: "grabli",
		title: "Грабли",
		task_text: "текст задачи",
	});
	const taskId = drafted.data.task_id;

	const bigDescription = `грабли ${"o".repeat(2993)}`; // ровно 3000 символов
	const bigLesson = `грабли ${"l".repeat(2993)}`;
	assert.equal(bigDescription.length, 3000);
	assert.equal(bigLesson.length, 3000);

	for (let i = 0; i < 3; i++) {
		await c.tool("record_incident", {
			task_id: taskId,
			description: bigDescription,
			lesson: bigLesson,
		});
	}

	const compact = await c.tool("search_precedents", { query: "грабли" });
	assert.equal(compact.data.incidents.length, 3);
	const compactJsonSize = Buffer.byteLength(JSON.stringify(compact.data), "utf8");
	assert.ok(compactJsonSize <= 4096, `компактный ответ ${compactJsonSize} байт`);
	for (const incident of compact.data.incidents) {
		assert.ok(incident.id, "у инцидента есть id");
		assert.ok(incident.description.length <= 281, `description ${incident.description.length}`);
		assert.ok(incident.lesson.length <= 281, `lesson ${incident.lesson.length}`);
		assert.ok(incident.description.endsWith("…"));
		assert.ok(incident.lesson.endsWith("…"));
		assert.equal(incident.description_length, 3000);
		assert.equal(incident.lesson_length, 3000);
	}

	const full = await c.tool("search_precedents", { query: "грабли", full: true });
	assert.equal(full.data.incidents.length, 3);
	for (const incident of full.data.incidents) {
		assert.ok(incident.id, "у инцидента есть id");
		assert.equal(incident.description.length, 3000);
		assert.equal(incident.lesson.length, 3000);
		assert.equal(incident.description, bigDescription);
		assert.equal(incident.lesson, bigLesson);
	}
});
