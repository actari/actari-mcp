// log_usage (спека ai-token-usage §1): событие UsageRecorded — токены AI по
// задаче. Числа явные либо сервер сам считает их из файла запуска (usage_file).
// Сервер настоящий, база временная, разговор по JSON-RPC через stdio.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { parseUsageFile } from "../usage-file.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");
const FIXTURES = join(ROOT, "test", "fixtures", "usage");
const fixture = (name) => join(FIXTURES, name);

function startClient(t) {
	const dir = mkdtempSync(join(tmpdir(), "actari-log-usage-"));
	const dbPath = join(dir, "journal.db");
	const env = { ...process.env, ACTARI_DB: dbPath };
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
	const usageEvents = (taskId) => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return db
				.prepare(
					"SELECT payload FROM events WHERE type = 'UsageRecorded' AND task_id = ? ORDER BY seq",
				)
				.all(taskId)
				.map((row) => JSON.parse(row.payload));
		} finally {
			db.close();
		}
	};
	const allUsageCount = () => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'UsageRecorded'").get().n;
		} finally {
			db.close();
		}
	};
	return { tool, usageEvents, allUsageCount };
}

const PROJECT = "demo";
const TASK = "demo/2026-10-24-usage";

async function drafted(c, taskId = TASK) {
	await c.tool("register_project", { name: PROJECT, root_path: "/tmp/demo" });
	const r = await c.tool("draft_task", {
		task_id: taskId,
		project: PROJECT,
		title: "Работа",
		task_text: "текст",
	});
	assert.ok(r.ok, r.error);
}

async function delegated(c, taskId = TASK) {
	await drafted(c, taskId);
	const r = await c.tool("delegate", { task_id: taskId, executor: "subagent" });
	assert.ok(r.ok, r.error);
}

const base = { project: PROJECT, task_id: TASK, role: "executor", source: "subagent" };

test("разбивка без total_tokens — total считается суммой", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		input_tokens: 10,
		output_tokens: 20,
		cache_read_tokens: 300,
		cache_write_tokens: 4,
		cost_usd: 0.25,
		model: "claude-sonnet-5",
	});
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents(TASK);
	assert.equal(event.total_tokens, 334);
	assert.equal(event.input_tokens, 10);
	assert.equal(event.cache_write_tokens, 4);
	assert.equal(event.cost_usd, 0.25);
	assert.equal(event.model, "claude-sonnet-5");
	assert.equal(event.project, PROJECT);
	assert.equal(event.role, "executor");
	assert.equal(event.source, "subagent");
});

test("только total_tokens — пишется как есть", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const r = await c.tool("log_usage", { ...base, total_tokens: 12345 });
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents(TASK);
	assert.equal(event.total_tokens, 12345);
	assert.ok(!("input_tokens" in event));
});

test("total_tokens при разбивке — как передан", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const r = await c.tool("log_usage", { ...base, total_tokens: 999, input_tokens: 1 });
	assert.ok(r.ok, r.error);
	assert.equal(c.usageEvents(TASK)[0].total_tokens, 999);
});

test("статус задачи запись токенов не меняет, допустимо после REPORTED/ACCEPTED", async (t) => {
	const c = startClient(t);
	await delegated(c);
	await c.tool("submit_report", { task_id: TASK, report: "готово" });
	assert.ok((await c.tool("log_usage", { ...base, total_tokens: 10 })).ok);
	await c.tool("accept", { task_id: TASK, evidence: "abc1234" });
	assert.ok((await c.tool("log_usage", { ...base, role: "acceptance", total_tokens: 5 })).ok);
	const got = await c.tool("get_task", { task_id: TASK });
	assert.equal(got.data.task.status, "ACCEPTED");
});

test("несколько записей суммируются в get_task", async (t) => {
	const c = startClient(t);
	await delegated(c);
	await c.tool("log_usage", { ...base, input_tokens: 100, output_tokens: 50, cost_usd: 0.1 });
	await c.tool("log_usage", { ...base, total_tokens: 1000, cache_read_tokens: 400 });
	await c.tool("log_usage", { ...base, role: "acceptance", input_tokens: 7, output_tokens: 3 });
	const got = await c.tool("get_task", { task_id: TASK });
	assert.ok(got.ok, got.error);
	const usage = got.data.usage;
	assert.equal(usage.records, 3);
	assert.deepEqual(usage.by_role, { executor: 1150, acceptance: 10 });
	assert.equal(usage.total_tokens, 1160);
	assert.equal(usage.input_tokens, 107);
	assert.equal(usage.output_tokens, 53);
	assert.equal(usage.cache_read_tokens, 400);
	assert.equal(usage.cache_write_tokens, null);
	assert.equal(usage.cost_usd, 0.1);
	const full = await c.tool("get_task", { task_id: TASK, full: true });
	assert.equal(full.data.usage.records, 3);
});

test("get_task: без записей поля usage нет, без cost — cost_usd нет", async (t) => {
	const c = startClient(t);
	await delegated(c);
	assert.ok(!("usage" in (await c.tool("get_task", { task_id: TASK })).data));
	await c.tool("log_usage", { ...base, total_tokens: 5 });
	const usage = (await c.tool("get_task", { task_id: TASK })).data.usage;
	assert.ok(!("cost_usd" in usage));
});

test("отказ на DRAFT и на несуществующей задаче", async (t) => {
	const c = startClient(t);
	await drafted(c);
	const r = await c.tool("log_usage", { ...base, total_tokens: 10 });
	assert.equal(r.ok, false);
	assert.match(r.error, /DRAFT/);
	assert.equal(c.allUsageCount(), 0);
	const missing = await c.tool("log_usage", {
		...base,
		task_id: "demo/нет-такой",
		total_tokens: 10,
	});
	assert.equal(missing.ok, false);
	assert.match(missing.error, /не найдена/);
	assert.equal(c.allUsageCount(), 0);
});

test("отказ на неверных числах — событие не пишется", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const bad = [
		{ total_tokens: -1 },
		{ input_tokens: 1.5 },
		{ total_tokens: "10" },
		{ total_tokens: Number.NaN },
		{ total_tokens: 10, cost_usd: -0.1 },
		{ total_tokens: 10, cost_usd: "0.1" },
		{ output_tokens: -3, input_tokens: 5 },
	];
	for (const args of bad) {
		const r = await c.tool("log_usage", { ...base, ...args });
		assert.equal(r.ok, false, JSON.stringify(args));
	}
	assert.equal(c.allUsageCount(), 0);
});

test("отказ: неверные role и source, чужой проект", async (t) => {
	const c = startClient(t);
	await delegated(c);
	assert.equal((await c.tool("log_usage", { ...base, role: "boss", total_tokens: 1 })).ok, false);
	assert.equal(
		(await c.tool("log_usage", { ...base, source: "cloud", total_tokens: 1 })).ok,
		false,
	);
	await c.tool("register_project", { name: "other", root_path: "/tmp/other" });
	const wrong = await c.tool("log_usage", { ...base, project: "other", total_tokens: 1 });
	assert.equal(wrong.ok, false);
	assert.match(wrong.error, /проект/);
	assert.equal(c.allUsageCount(), 0);
});

test("отказ без чисел вовсе и при числах вместе с usage_file", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const none = await c.tool("log_usage", { ...base });
	assert.equal(none.ok, false);
	assert.match(none.error, /usage_file|total_tokens/);
	const both = await c.tool("log_usage", {
		...base,
		total_tokens: 10,
		usage_file: fixture("claude-result.json"),
	});
	assert.equal(both.ok, false);
	assert.match(both.error, /один источник|вместе/);
	assert.equal(c.allUsageCount(), 0);
});

test("usage_file: транскрипт Claude Code — дедуп по message.id", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const r = await c.tool("log_usage", { ...base, usage_file: fixture("claude-transcript.jsonl") });
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents(TASK);
	assert.equal(event.usage_format, "claude-transcript");
	assert.equal(event.input_tokens, 18);
	assert.equal(event.output_tokens, 180);
	assert.equal(event.cache_read_tokens, 6000);
	assert.equal(event.cache_write_tokens, 300);
	assert.equal(event.total_tokens, 6498);
	assert.equal(event.model, "claude-sonnet-5");
	assert.ok(!("usage_file" in event), "путь к файлу в событие не пишется");
});

test("usage_file: claude -p json", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		source: "headless",
		usage_file: fixture("claude-result.json"),
	});
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents(TASK);
	assert.equal(event.usage_format, "claude-json");
	assert.equal(event.total_tokens, 3700);
	assert.equal(event.input_tokens, 100);
	assert.equal(event.output_tokens, 200);
	assert.equal(event.cache_read_tokens, 3000);
	assert.equal(event.cache_write_tokens, 400);
	assert.equal(event.cost_usd, 0.5);
	assert.equal(event.model, "claude-sonnet-5, claude-haiku-5");
	assert.equal(event.source, "headless");
});

test("usage_file: opencode — сумма step-finish, reasoning в output", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const r = await c.tool("log_usage", {
		...base,
		source: "headless",
		model: "opencode-go/deepseek-v4-flash",
		usage_file: fixture("opencode-events.jsonl"),
	});
	assert.ok(r.ok, r.error);
	const [event] = c.usageEvents(TASK);
	assert.equal(event.usage_format, "opencode-json");
	assert.equal(event.input_tokens, 1400);
	assert.equal(event.output_tokens, 550);
	assert.equal(event.cache_read_tokens, 80);
	assert.equal(event.cache_write_tokens, 70);
	assert.equal(event.total_tokens, 2100);
	assert.equal(event.cost_usd, 0.015);
	assert.equal(event.model, "opencode-go/deepseek-v4-flash", "переданная модель главнее файла");
});

test("usage_file пустой / не JSON / без токенов / нет файла — отказ с причиной", async (t) => {
	const c = startClient(t);
	await delegated(c);
	const dir = mkdtempSync(join(tmpdir(), "actari-usage-files-"));
	const empty = join(dir, "empty.jsonl");
	const garbage = join(dir, "garbage.txt");
	const noTokens = join(dir, "no-tokens.jsonl");
	const zero = join(dir, "zero.json");
	writeFileSync(empty, "");
	writeFileSync(garbage, "это не JSON\nи это тоже\n");
	writeFileSync(noTokens, `${JSON.stringify({ type: "user", message: { content: "x" } })}\n`);
	writeFileSync(
		zero,
		JSON.stringify({
			type: "result",
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	);
	for (const file of [empty, garbage, noTokens, zero, join(dir, "нет-такого.json")]) {
		const r = await c.tool("log_usage", { ...base, usage_file: file });
		assert.equal(r.ok, false, file);
		assert.match(r.error, /токены не записаны|usage_file/, file);
	}
	assert.equal(c.allUsageCount(), 0);
});

test("parseUsageFile: ошибки — Error с причиной по-русски", () => {
	assert.throws(() => parseUsageFile("/нет/такого/файла.jsonl"), /не удалось прочитать/);
});

test("parseUsageFile: result внутри массива (stream-json) и один объект в одну строку", () => {
	const dir = mkdtempSync(join(tmpdir(), "actari-usage-files-"));
	const arr = join(dir, "arr.json");
	writeFileSync(
		arr,
		JSON.stringify([
			{ type: "system" },
			{ type: "result", usage: { input_tokens: 4, output_tokens: 6 }, total_cost_usd: 0 },
		]),
	);
	const parsed = parseUsageFile(arr);
	assert.equal(parsed.format, "claude-json");
	assert.equal(parsed.input_tokens, 4);
	assert.equal(parsed.cache_read_tokens, 0);
	assert.equal(parsed.cost_usd, 0);
});
