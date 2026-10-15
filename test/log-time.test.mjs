// log_time и duration_minutes (спека time-tracking Р10–Р13): списание времени
// уходит только в облако (POST /api/mcp/work-logs), локальная SQLite не
// меняется; submit_report принимает необязательную длительность в минутах.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	SCHEMA,
	TOKEN,
	WS,
	cleanEnv,
	mcpEnv,
	startIntentCloud,
	startMcp,
} from "./support/intent-cloud.mjs";
import { localDay } from "./support/local-day.mjs";

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-log-time-"));

const CLOUD_TASK = "cloud-task-1";
const workLogTasks = () => ({ [CLOUD_TASK]: { title: "Сделать доску", totalMinutes: 120 } });

function lastReportPayload(dir, taskId) {
	const db = new DatabaseSync(join(dir, "journal.db"), { readOnly: true });
	try {
		const row = db
			.prepare(
				"SELECT payload FROM events WHERE task_id = ? AND type = 'ReportSubmitted' ORDER BY seq DESC LIMIT 1",
			)
			.get(taskId);
		return row ? JSON.parse(row.payload) : null;
	} finally {
		db.close();
	}
}

function eventCount(dir) {
	const db = new DatabaseSync(join(dir, "journal.db"), { readOnly: true });
	try {
		return db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
	} finally {
		db.close();
	}
}

// Задача журнала, дошедшая до DELEGATED — можно слать отчёт.
async function delegated(c, taskId = "demo/2026-10-15-work", extraDraft = {}) {
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo" });
	const drafted = await c.tool("draft_task", {
		task_id: taskId,
		project: "demo",
		title: "Работа",
		task_text: "текст",
		...extraDraft,
	});
	assert.equal(drafted.ok, true, drafted.text);
	const del = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(del.ok, true, del.text);
	return taskId;
}

test("submit_report с duration_minutes: 25 кладёт длительность в payload", async (t) => {
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	const taskId = await delegated(c);
	const res = await c.tool("submit_report", {
		task_id: taskId,
		report: "готово",
		duration_minutes: 25,
	});
	assert.equal(res.ok, true, res.text);
	assert.deepEqual(lastReportPayload(dir, taskId), { report: "готово", duration_minutes: 25 });
});

test("submit_report без duration_minutes: в payload только report", async (t) => {
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	const taskId = await delegated(c);
	assert.equal((await c.tool("submit_report", { task_id: taskId, report: "готово" })).ok, true);
	assert.deepEqual(lastReportPayload(dir, taskId), { report: "готово" });
});

for (const bad of [0, -5, 1441, 2.5]) {
	test(`submit_report с duration_minutes: ${bad} — ошибка, событие не записано`, async (t) => {
		const dir = tmpDir();
		const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
		const taskId = await delegated(c);
		const before = eventCount(dir);
		const res = await c.tool("submit_report", {
			task_id: taskId,
			report: "готово",
			duration_minutes: bad,
		});
		assert.equal(res.ok, false, res.text);
		assert.match(res.text, /duration_minutes.*целое.*1.*1440/);
		assert.equal(eventCount(dir), before);
		assert.equal(lastReportPayload(dir, taskId), null);
	});
}

test("submit_report с duration_minutes строкой — ошибка типа", async (t) => {
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	const taskId = await delegated(c);
	const res = await c.tool("submit_report", {
		task_id: taskId,
		report: "готово",
		duration_minutes: "25",
	});
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /duration_minutes \(ожидается number\)/);
});

test("log_time без sync.json: понятная ошибка, в облако ничего не уходит, локально ничего не пишется", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo" });
	const before = eventCount(dir);
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 1.5 });
	assert.equal(res.ok, false, res.text);
	assert.equal(
		res.text,
		"Ошибка: Облако не подключено (нет sync.json) — log_time пишет только в облако, локально ничего не записано. Подключи: connect",
	);
	assert.deepEqual(cloud.state.workLogs, []);
	assert.equal(eventCount(dir), before);
});

test("log_time по id облака: минуты = round(часы × 60), дата по умолчанию — сегодня, успех текстом", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	const dir = tmpDir();
	const c = startMcp(t, mcpEnv(dir, cloud.baseUrl));
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo" });
	const before = eventCount(dir);
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 1.5, note: "ревью" });
	assert.equal(res.ok, true, res.text);
	assert.equal(cloud.state.workLogs.length, 1);
	assert.deepEqual(cloud.state.workLogs[0], {
		taskId: CLOUD_TASK,
		minutes: 90,
		date: localDay(),
		note: "ревью",
	});
	assert.equal(
		res.text,
		`Списано 1 ч 30 мин на задачу Сделать доску (${localDay()}). Факт задачи: 3,5 ч`,
	);
	assert.equal(eventCount(dir), before, "локальный журнал не тронут");
});

test("log_time: явная дата уходит как есть, без note — note не передаётся", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 2, date: "2026-10-14" });
	assert.equal(res.ok, true, res.text);
	assert.deepEqual(cloud.state.workLogs[0], {
		taskId: CLOUD_TASK,
		minutes: 120,
		date: "2026-10-14",
	});
	assert.match(res.text, /^Списано 2 ч на задачу Сделать доску \(2026-10-14\)\. Факт задачи: 4 ч$/);
});

test("log_time по id журнала с intent_task_id: облако получает id намерения", async (t) => {
	const cloud = await startIntentCloud(t, {
		intents: [{ id: "intent-1" }],
		workLogTasks: { "intent-1": { title: "Сделать доску", totalMinutes: 0 } },
	});
	const dir = tmpDir();
	const c = startMcp(t, mcpEnv(dir, cloud.baseUrl));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);
	const journalId = `demo/${localDay()}-work`;
	const drafted = await c.tool("draft_task", {
		project: "demo",
		slug: "work",
		title: "Работа",
		task_text: "текст",
		intent_task_id: "intent-1",
	});
	assert.equal(drafted.ok, true, drafted.text);

	const res = await c.tool("log_time", { task_id: journalId, hours: 1.5 });
	assert.equal(res.ok, true, res.text);
	assert.equal(cloud.state.workLogs[0].taskId, "intent-1");
	assert.equal(cloud.state.workLogs[0].minutes, 90);
	assert.match(res.text, /^Списано 1 ч 30 мин на задачу Сделать доску /);
	assert.match(res.text, /Факт задачи: 1,5 ч$/);
});

test("log_time по id журнала без намерения — ошибка, облако не спрошено", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	const taskId = await delegated(c);
	const res = await c.tool("log_time", { task_id: taskId, hours: 1 });
	assert.equal(res.ok, false, res.text);
	assert.equal(
		res.text,
		`Ошибка: Задача журнала ${taskId} не связана с задачей облака (нет intent_task_id) — время не списано`,
	);
	assert.deepEqual(cloud.state.workLogs, []);
});

test("log_time: 404 на первой цели, 201 на второй — успех", async (t) => {
	const a = await startIntentCloud(t, { workLogTasks: {} });
	const b = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	const dir = tmpDir();
	const configPath = join(dir, "sync.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			targets: [
				{ alias: "a", url: a.baseUrl, token: TOKEN, journalId: "j-a" },
				{ alias: "b", url: b.baseUrl, token: TOKEN, journalId: "j-b" },
			],
		}),
	);
	const c = startMcp(
		t,
		cleanEnv({
			ACTARI_DB: join(dir, "journal.db"),
			ACTARI_SCHEMA: SCHEMA,
			ACTARI_SYNC_CONFIG: configPath,
			ACTARI_INTENT_POLL_MS: "3600000",
		}),
	);
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 1 });
	assert.equal(res.ok, true, res.text);
	assert.equal(a.state.workLogs.length, 1, "первая цель спрошена");
	assert.equal(b.state.workLogs.length, 1);
	assert.match(res.text, /^Списано 1 ч на задачу Сделать доску /);
});

test("log_time: задача не найдена ни в одной цели — ошибка", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: {} });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	const res = await c.tool("log_time", { task_id: "nope", hours: 1 });
	assert.equal(res.ok, false, res.text);
	assert.equal(res.text, "Ошибка: Задача nope не найдена в облаке — время не списано");
});

test("log_time: 403 облака — текст про права", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	cloud.state.workLogOverride = { status: 403, error: "read-only token" };
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 1 });
	assert.equal(res.ok, false, res.text);
	assert.equal(
		res.text,
		"Ошибка: Нет прав списывать время на задачу (токен только для чтения или роль наблюдателя)",
	);
});

test("log_time: 400 облака — текст ошибки облака", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	cloud.state.workLogOverride = { status: 400, error: "Минимум 15 минут" };
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 0.1 });
	assert.equal(res.ok, false, res.text);
	assert.equal(res.text, "Ошибка: Минимум 15 минут");
});

test("log_time: облако не отвечает — «Облако недоступно»", async (t) => {
	// Порт 9 (discard) на 127.0.0.1 никто не слушает: соединение отклоняется.
	const c = startMcp(t, mcpEnv(tmpDir(), "http://127.0.0.1:9", { ACTARI_INBOX_TIMEOUT_MS: "500" }));
	const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 1 });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /^Ошибка: Облако недоступно: .+ — время не списано$/);
});

test("log_time: неверные hours и date отклоняются до обращения к облаку", async (t) => {
	const cloud = await startIntentCloud(t, { workLogTasks: workLogTasks() });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	for (const hours of [0, -1]) {
		const res = await c.tool("log_time", { task_id: CLOUD_TASK, hours });
		assert.equal(res.ok, false, res.text);
		assert.match(res.text, /hours.*больше 0/);
	}
	const badDate = await c.tool("log_time", { task_id: CLOUD_TASK, hours: 1, date: "14.10.2026" });
	assert.equal(badDate.ok, false, badDate.text);
	assert.match(badDate.text, /date.*ГГГГ-ММ-ДД/);
	const noHours = await c.tool("log_time", { task_id: CLOUD_TASK });
	assert.equal(noHours.ok, false);
	assert.match(noHours.text, /Нет обязательных полей: hours/);
	assert.deepEqual(cloud.state.workLogs, []);
});
