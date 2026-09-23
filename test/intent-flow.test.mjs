// Петля намерений на процессе сервера (спека 2026-09-14 §9): вмешательство
// человека в облаке действует на первом же действии агента.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	LEAD,
	ME,
	OTHER_WS,
	SCHEMA,
	TOKEN,
	WS,
	cleanEnv,
	mcpEnv,
	startIntentCloud,
	startMcp,
	today,
	waitFor,
} from "./support/intent-cloud.mjs";

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-intent-flow-"));

async function setupTaken(
	t,
	{ cloudOptions = {}, project = { name: "demo", cloud_workspace_id: WS.id }, envExtra = {} } = {},
) {
	const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }], ...cloudOptions });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl, envExtra));
	await c.tool("register_project", {
		name: project.name,
		root_path: `/tmp/${project.name}`,
		...(project.cloud_workspace_id ? { cloud_workspace_id: project.cloud_workspace_id } : {}),
	});
	const taken = await c.tool("take", { task_id: "intent-1" });
	assert.equal(taken.ok, true, taken.text);
	return { cloud, c, taskId: `${project.name}/${today()}-work` };
}

async function draft(c, project = "demo", extra = {}) {
	return c.tool("draft_task", {
		project,
		slug: "work",
		title: "Работа",
		task_text: "текст",
		intent_task_id: "intent-1",
		...extra,
	});
}

async function eventTypes(c, taskId) {
	const r = await c.tool("get_task", { task_id: taskId });
	return r.data.events.map((event) => event.type);
}

test("отмена человеком: следующий акт отклонён текстом, событие не пишется, mark_failed проходит", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	assert.equal((await draft(c)).ok, true);
	assert.equal((await c.tool("delegate", { task_id: taskId, executor: "grok" })).ok, true);

	cloud.cancel("intent-1", "фича снята");
	const report = await c.tool("submit_report", { task_id: taskId, report: "готово" });
	assert.equal(report.ok, false);
	assert.match(
		report.text,
		/^Ошибка: намерение «Намерение intent-1» \(intent-1\) отменено в облаке — Лид, .+ UTC: «фича снята»/,
	);
	assert.match(report.text, /mark_failed/);
	assert.deepEqual(await eventTypes(c, taskId), ["TaskDrafted", "Delegated"]);

	const failed = await c.tool("mark_failed", {
		task_id: taskId,
		reason: "отменено человеком: фича снята",
	});
	assert.equal(failed.ok, true);
	assert.deepEqual(await eventTypes(c, taskId), ["TaskDrafted", "Delegated", "Failed"]);
});

test("ручное закрытие человеком отклоняет accept", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	await c.tool("delegate", { task_id: taskId, executor: "grok" });
	await c.tool("submit_report", { task_id: taskId, report: "готово" });
	cloud.closeManually("intent-1", "сделали руками");
	const accepted = await c.tool("accept", { task_id: taskId, evidence: "abc123" });
	assert.equal(accepted.ok, false);
	assert.match(accepted.text, /закрыто человеком вручную — Лид/);
	assert.deepEqual(await eventTypes(c, taskId), ["TaskDrafted", "Delegated", "ReportSubmitted"]);
});

test("возврат в инбокс и передача другому: «больше не твоё»", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	cloud.returnToInbox("intent-1", "переделать");
	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, false);
	assert.match(delegated.text, /больше не твоё: возвращено в инбокс — Лид, .+: «переделать»/);

	const second = await setupTaken(t);
	await draft(second.c);
	second.cloud.giveTo("intent-1", { id: "u-ira", name: "Ира" });
	const rework = await second.c.tool("delegate", { task_id: second.taskId, executor: "grok" });
	assert.match(rework.text, /больше не твоё: его взял Ира/);
});

test("новые критерии: delegate с уведомлением, accept отклонён до intent_status", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	cloud.changeCriteria("intent-1", "- отдаёт 7 дней\n- кэш 10 минут");
	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, true);
	assert.equal(
		delegated.data?.status,
		"DELEGATED",
		"JSON результата цел: уведомления — отдельным блоком",
	);
	assert.equal(delegated.parts.length, 2);
	assert.match(
		delegated.text,
		/\n\nИзменения по твоим намерениям:\n- критерии приёмки «Намерение intent-1» \(intent-1\) изменились \(версия 1 → 2\):\n {2}\+ - кэш 10 минут/,
	);

	await c.tool("submit_report", { task_id: taskId, report: "готово" });
	const blocked = await c.tool("accept", { task_id: taskId, evidence: "abc123" });
	assert.equal(blocked.ok, false);
	assert.match(blocked.text, /intent_status \{ task_id: "intent-1" \}/);
	assert.deepEqual(await eventTypes(c, taskId), ["TaskDrafted", "Delegated", "ReportSubmitted"]);
});

test("draft_task: без take — отказ; проект другого пространства — отказ; без привязки при двух пространствах — отказ", async (t) => {
	const cloud = await startIntentCloud(t, {
		intents: [{ id: "intent-1" }],
		workspaces: [WS, OTHER_WS],
	});
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	await c.tool("register_project", {
		name: "elsewhere",
		root_path: "/tmp/elsewhere",
		cloud_workspace_id: OTHER_WS.id,
	});
	await c.tool("register_project", { name: "loose", root_path: "/tmp/loose" });

	const notTaken = await draft(c);
	assert.equal(notTaken.ok, false);
	assert.match(notTaken.text, /не взято тобой — сначала take \{ task_id: "intent-1" \}/);

	await c.tool("take", { task_id: "intent-1" });
	const wrongSpace = await draft(c, "elsewhere");
	assert.equal(wrongSpace.ok, false);
	assert.match(
		wrongSpace.text,
		/проект «elsewhere» привязан к другому пространству \(ws-other\), а намерение intent-1 — из пространства alpha-space/,
	);
	assert.match(
		wrongSpace.text,
		/sync_scope \{ workspace: "alpha-space", projects: \["elsewhere"\] \}/,
	);

	const unbound = await draft(c, "loose");
	assert.equal(unbound.ok, false);
	assert.match(
		unbound.text,
		/проект «loose» не привязан к пространству, а пространств у токена несколько/,
	);

	const ok = await draft(c, "demo");
	assert.equal(ok.ok, true, ok.text);
});

test("draft_task: без привязки при одном пространстве — проходит с уведомлением", async (t) => {
	const { c } = await setupTaken(t, { project: { name: "loose" } });
	const drafted = await draft(c, "loose");
	assert.equal(drafted.ok, true, drafted.text);
	assert.match(
		drafted.text,
		/проект «loose» не привязан к пространству — пока пространство одно, журнал уедет в alpha-space/,
	);
});

test("облако недоступно: решение по кэшу с предупреждением, работа не встаёт", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	cloud.state.down = true;
	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, true, delegated.text);
	assert.match(
		delegated.text,
		/состояние намерения intent-1 не проверено: облако недоступно \(HTTP 503\) — решение по кэшу на/,
	);
});

test("старое облако без маршрута намерений: проверки выключаются, работа идёт", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t, { cloudOptions: { intentsRoute: false } });
	const drafted = await draft(c);
	assert.equal(drafted.ok, true, drafted.text);
	assert.match(drafted.text, /облако не поддерживает состояние намерений/);
	cloud.cancel("intent-1");
	assert.equal(
		(await c.tool("delegate", { task_id: taskId, executor: "grok" })).ok,
		true,
		"проверок нет",
	);
});

test("get_task показывает сводку намерения; задача без намерения — без сводки", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	cloud.cancel("intent-1");
	const card = await c.tool("get_task", { task_id: taskId });
	assert.equal(card.ok, true);
	assert.deepEqual(card.data.intent, {
		intent_task_id: "intent-1",
		state: "cancelled",
		override: "CANCELLED",
		is_mine: true,
		criteria_version: 1,
		source: "cloud",
	});

	await c.tool("draft_task", {
		project: "demo",
		slug: "plain",
		title: "Без намерения",
		task_text: "т",
	});
	const plain = await c.tool("get_task", { task_id: `demo/${today()}-plain` });
	assert.equal("intent" in plain.data, false);
});

test("inbox: моя/свободная, приоритет, критерии, проект журнала; несколько целей — без дублей", async (t) => {
	const a = await startIntentCloud(t, {
		intents: [
			{ id: "free-urgent", priority: "URGENT", acceptanceCriteria: "- a\n- b" },
			{ id: "mine", assignee: ME },
		],
	});
	const b = await startIntentCloud(t, {
		intents: [
			{ id: "mine", assignee: ME },
			{ id: "only-b", acceptanceCriteria: null },
		],
	});
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
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});

	const inbox = await c.tool("inbox");
	assert.match(inbox.text, /^3 намерений:/);
	assert.ok(
		inbox.text.includes(
			"- free-urgent [срочно] Намерение free-urgent — свободная · 2 критерия\n  фича: Прогноз · пространство: alpha-space · проект журнала: demo",
		),
		inbox.text,
	);
	assert.ok(inbox.text.includes("- mine Намерение mine — моя · 1 критерий"), inbox.text);
	assert.ok(
		inbox.text.includes("- only-b Намерение only-b — свободная · без критериев"),
		inbox.text,
	);
	assert.equal(inbox.text.split("- mine ").length - 1, 1, "дубль из второй цели не показан");
});

test("take: отказы облака текстом; успешный take отдаёт критерии и проект и запоминает увиденное", async (t) => {
	const cloud = await startIntentCloud(t, {
		intents: [
			{
				id: "other",
				intentState: "TAKEN",
				takenBy: { id: "u-ira", name: "Ира" },
				assignee: { id: "u-ira", name: "Ира" },
				isMine: false,
			},
			{
				id: "cancelled",
				override: { kind: "CANCELLED", note: "снята", by: LEAD, at: "2026-09-14T09:00:00.000Z" },
			},
			{ id: "intent-1", priority: "HIGH", assignee: ME },
		],
	});
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});

	assert.match(
		(await c.tool("take", { task_id: "other" })).text,
		/^не взято: намерение «Намерение other» уже взял Ира \(/,
	);
	assert.match(
		(await c.tool("take", { task_id: "cancelled" })).text,
		/^не взято: намерение «Намерение cancelled» отменено — Лид, 2026-09-14 09:00 UTC: «снята»/,
	);

	const taken = await c.tool("take", { task_id: "intent-1" });
	for (const expected of [
		/Приоритет: высокий/,
		/Исполнитель: Алексей/,
		/Проект журнала: demo \(привязан к пространству alpha-space\)/,
		/## Критерии приёмки \(версия 1\)\n- отдаёт 7 дней/,
		/draft_task с intent_task_id: "intent-1" \(project: "demo", /,
	]) {
		assert.match(taken.text, expected);
	}

	// Критерии поменяли до draft: take запомнил версию 1, draft получает разницу
	cloud.changeCriteria("intent-1", "- новое");
	const drafted = await draft(c);
	assert.equal(drafted.ok, true, drafted.text);
	assert.match(drafted.text, /изменились \(версия 1 → 2\)/);
});

test("intent_status: состояние и разница критериев; после просмотра accept проходит", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	await c.tool("delegate", { task_id: taskId, executor: "grok" });
	await c.tool("submit_report", { task_id: taskId, report: "готово" });
	cloud.changeCriteria("intent-1", "- отдаёт 7 дней\n- кэш 10 минут");
	assert.equal((await c.tool("accept", { task_id: taskId, evidence: "abc123" })).ok, false);

	const status = await c.tool("intent_status", { task_id: taskId });
	assert.equal(status.ok, true);
	for (const expected of [
		/^Намерение «Намерение intent-1» \(intent-1\)/,
		/Состояние: взято/,
		/Критерии приёмки \(версия 2\):\n- отдаёт 7 дней\n- кэш 10 минут/,
		/Изменения с прошлого просмотра \(версия 1 → 2\):\n {2}\+ - кэш 10 минут/,
		/Последнее вмешательство: критерии изменены — Лид/,
	]) {
		assert.match(status.text, expected);
	}

	const accepted = await c.tool("accept", { task_id: taskId, evidence: "abc123" });
	assert.equal(accepted.ok, true, accepted.text);

	const byCloudId = await c.tool("intent_status", { task_id: "intent-1" });
	assert.doesNotMatch(byCloudId.text, /Изменения с прошлого просмотра/, "всё уже увидено");
	const unlinked = await c.tool("intent_status", { task_id: "demo/2026-01-01-nothing" });
	assert.equal(unlinked.ok, false);
	assert.match(unlinked.text, /не связана с намерением/);
});

test("release_intent: живая попытка — отказ; после mark_failed отпущено; черновик не мешает", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	await c.tool("delegate", { task_id: taskId, executor: "grok" });

	const blocked = await c.tool("release_intent", { task_id: "intent-1", note: "не успеваю" });
	assert.equal(blocked.ok, false);
	assert.match(
		blocked.text,
		new RegExp(`есть живые попытки в журнале — ${taskId.replace("/", "\\/")} \\(DELEGATED\\)`),
	);
	assert.deepEqual(cloud.state.releases, []);

	await c.tool("mark_failed", { task_id: taskId, reason: "не успеваю" });
	const released = await c.tool("release_intent", { task_id: "intent-1", note: "не успеваю" });
	assert.equal(released.ok, true, released.text);
	assert.match(released.text, /^намерение «Намерение intent-1» отпущено в инбокс/);
	assert.deepEqual(cloud.state.releases, [{ id: "intent-1", note: "не успеваю" }]);
	assert.equal(cloud.state.views.get("intent-1").intentState, "PROPOSED");

	// Черновик по намерению: закрыть событием нельзя, отпускать не мешает
	const second = await setupTaken(t);
	await draft(second.c);
	const withDraft = await second.c.tool("release_intent", { task_id: "intent-1" });
	assert.equal(withDraft.ok, true, withDraft.text);
	assert.match(
		withDraft.text,
		new RegExp(`черновик ${second.taskId.replace("/", "\\/")} остаётся в журнале`),
	);

	const notMine = await second.c.tool("release_intent", { task_id: "intent-1" });
	assert.match(notMine.text, /^не отпущено: намерение intent-1 взято не тобой/);
});

test("мок: release ставит reopenedAt, часы не опережают реальные", async (t) => {
	const before = Date.now();
	const { cloud, c } = await setupTaken(t);
	await draft(c);
	const released = await c.tool("release_intent", { task_id: "intent-1" });
	assert.equal(released.ok, true, released.text);
	const view = cloud.state.views.get("intent-1");
	assert.ok(view.reopenedAt, "release ставит reopenedAt, как core после RELEASE");
	const after = Date.now();
	const reopenedMs = Date.parse(view.reopenedAt);
	assert.ok(reopenedMs >= before, `reopenedAt ${view.reopenedAt} раньше старта теста`);
	assert.ok(
		reopenedMs - after < 100,
		`reopenedAt ${view.reopenedAt} опережает реальные часы (после=${new Date(after).toISOString()})`,
	);
	assert.ok(
		cloud.state.clock.getTime() - after < 100,
		`часы мока ${cloud.state.clock.toISOString()} опережают реальные`,
	);
});

test("фоновый опрос: изменение приходит в ответ следующего инструмента один раз; без намерений опроса нет", async (t) => {
	const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
	const idle = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl, { ACTARI_INTENT_POLL_MS: "100" }));
	await idle.tool("list_tasks");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.deepEqual(cloud.state.changesQueries, [], "кэш пуст — опрашивать нечего");

	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl, { ACTARI_INTENT_POLL_MS: "100" }));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	await c.tool("take", { task_id: "intent-1" });
	cloud.cancel("intent-1", "фича снята");

	let text = "";
	const arrived = await waitFor(async () => {
		text = (await c.tool("list_tasks")).text;
		return text.includes("Изменения по твоим намерениям:");
	});
	assert.ok(arrived, text);
	assert.match(text, /- «Намерение intent-1» \(intent-1\): отменено — Лид, .+ UTC: «фича снята»/);

	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.doesNotMatch(
		(await c.tool("list_tasks")).text,
		/Изменения по твоим намерениям/,
		"показано один раз",
	);
});

test("предупреждение синка о ненайденном намерении доходит до агента", async (t) => {
	const { c } = await setupTaken(t, { cloudOptions: { missingIntentIds: ["intent-1"] } });
	const drafted = await draft(c);
	assert.equal(drafted.ok, true, drafted.text);
	let text = drafted.text;
	const arrived =
		text.includes("синк: задача") ||
		(await waitFor(async () => {
			text = (await c.tool("list_tasks")).text;
			return text.includes("синк: задача");
		}));
	assert.ok(arrived, text);
	assert.match(
		text,
		new RegExp(
			`синк: задача demo/${today()}-work ссылается на намерение intent-1, которого нет в пространстве alpha-space`,
		),
	);
});

test("release → retake → тот же slug: старый черновик — история, другой slug проходит", async (t) => {
	const { c, taskId } = await setupTaken(t);
	assert.equal((await draft(c)).ok, true);
	assert.deepEqual(await eventTypes(c, taskId), ["TaskDrafted"]);

	assert.equal((await c.tool("release_intent", { task_id: "intent-1" })).ok, true);
	assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);

	const same = await draft(c);
	assert.equal(same.ok, false);
	assert.match(
		same.text,
		new RegExp(`черновик ${taskId.replace("/", "\\/")} заведён до возврата намерения в инбокс`),
	);
	assert.match(same.text, /draft_task с другим slug и intent_task_id: "intent-1"/);
	assert.deepEqual(await eventTypes(c, taskId), ["TaskDrafted"]);

	const other = await c.tool("draft_task", {
		project: "demo",
		slug: "work-2",
		title: "Работа",
		task_text: "текст",
		intent_task_id: "intent-1",
	});
	assert.equal(other.ok, true, other.text);
	const delegated = await c.tool("delegate", {
		task_id: `demo/${today()}-work-2`,
		executor: "grok",
	});
	assert.equal(delegated.ok, true, delegated.text);
});

test("человек вернул в инбокс, черновик DRAFT: не делегируй, без mark_failed", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	cloud.returnToInbox("intent-1", "переделать");
	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, false);
	assert.match(delegated.text, /Не делегируй/);
	assert.doesNotMatch(delegated.text, /mark_failed/);
});

test("отмена при DRAFT: текст без mark_failed", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	cloud.cancel("intent-1", "фича снята");
	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, false);
	assert.match(delegated.text, /отменено в облаке/);
	assert.match(delegated.text, /Не делегируй/);
	assert.doesNotMatch(delegated.text, /mark_failed/);
});

test("попытка DELEGATED, человек вернул в инбокс: подсказка mark_failed осталась", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	await draft(c);
	assert.equal((await c.tool("delegate", { task_id: taskId, executor: "grok" })).ok, true);
	cloud.returnToInbox("intent-1", "переделать");
	const report = await c.tool("submit_report", { task_id: taskId, report: "готово" });
	assert.equal(report.ok, false);
	assert.match(report.text, /mark_failed/);
	assert.doesNotMatch(report.text, /Не делегируй/);
});

test("задача без take: submit_report говорит сначала take, после take проходит", async (t) => {
	const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
	const dir = tmpDir();
	const c = startMcp(t, mcpEnv(dir, cloud.baseUrl));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	const taskId = `demo/${today()}-legacy`;
	const journal = new DatabaseSync(join(dir, "journal.db"));
	journal.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)").run(
		taskId,
		"TaskDrafted",
		JSON.stringify({
			project: "demo",
			title: "Старая",
			task_text: "т",
			intent_task_id: "intent-1",
		}),
	);
	journal
		.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)")
		.run(taskId, "Delegated", JSON.stringify({ executor: "grok" }));
	journal.close();

	assert.equal(cloud.state.views.get("intent-1").intentState, "PROPOSED");
	assert.equal(cloud.state.views.get("intent-1").isMine, false);

	const report = await c.tool("submit_report", { task_id: taskId, report: "готово" });
	assert.equal(report.ok, false);
	assert.match(report.text, /сначала take \{ task_id: "intent-1" \}/);
	assert.doesNotMatch(report.text, /mark_failed/);

	assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);
	const again = await c.tool("submit_report", { task_id: taskId, report: "готово" });
	assert.equal(again.ok, true, again.text);
});

test("зависший курсор синка: draft_task непривязанного проекта укладывается в таймаут", async (t) => {
	const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }], hang: ["cursor"] });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl, { ACTARI_INTENT_TIMEOUT_MS: "300" }));
	await c.tool("register_project", { name: "loose", root_path: "/tmp/loose" });
	assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);
	const started = Date.now();
	const drafted = await draft(c, "loose");
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 3000, `draft_task занял ${elapsed} мс`);
	assert.equal(drafted.ok, true, drafted.text);
	assert.match(drafted.text, /число пространств проверить не удалось/);
});

test("зависший инбокс: inbox укладывается в таймаут", async (t) => {
	const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }], hang: ["inbox"] });
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl, { ACTARI_INBOX_TIMEOUT_MS: "300" }));
	const started = Date.now();
	const inbox = await c.tool("inbox");
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 3000, `inbox занял ${elapsed} мс`);
	assert.match(inbox.text, /ошибка инбокса/);
});

test("опрос изменений дочитывает ленту постранично при лимите облака", async (t) => {
	const cloud = await startIntentCloud(t, {
		intents: [{ id: "one" }, { id: "two" }, { id: "three" }],
		changesLimit: 2,
	});
	const c = startMcp(
		t,
		mcpEnv(tmpDir(), cloud.baseUrl, {
			ACTARI_INTENT_POLL_MS: "100",
			ACTARI_CHANGES_PAGE: "2",
		}),
	);
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	for (const id of ["one", "two", "three"]) {
		assert.equal((await c.tool("take", { task_id: id })).ok, true);
	}
	cloud.cancel("one", "снята");
	cloud.changeCriteria("two", "- новое");
	cloud.setPriority("three", "HIGH");

	const seen = new Set();
	let text = "";
	const arrived = await waitFor(async () => {
		text = (await c.tool("list_tasks")).text;
		for (const id of ["one", "two", "three"]) {
			if (text.includes(`(${id})`)) seen.add(id);
		}
		return seen.size === 3;
	});
	assert.ok(arrived, `seen=${[...seen].join(",") || "∅"} text=${text}`);
});

test("кэш потерян: delegate с уведомлением о критериях, accept до intent_status отказ", async (t) => {
	const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
	const dir = tmpDir();
	const c = startMcp(t, mcpEnv(dir, cloud.baseUrl));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);
	assert.equal((await draft(c)).ok, true);
	const taskId = `demo/${today()}-work`;
	const journal = new DatabaseSync(join(dir, "journal.db"));
	journal.exec("DELETE FROM intent_cache");
	journal.close();

	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, true, delegated.text);
	assert.match(delegated.text, /критерии приёмки/);
	assert.equal((await c.tool("submit_report", { task_id: taskId, report: "готово" })).ok, true);
	const blocked = await c.tool("accept", { task_id: taskId, evidence: "abc123" });
	assert.equal(blocked.ok, false);
	assert.match(blocked.text, /intent_status \{ task_id: "intent-1" \}/);
	assert.equal((await c.tool("intent_status", { task_id: taskId })).ok, true);
	assert.equal((await c.tool("accept", { task_id: taskId, evidence: "abc123" })).ok, true);
});

test("release_intent: отказы облака по причине 409 и 403", async (t) => {
	const { cloud, c } = await setupTaken(t);
	await draft(c);
	const cases = [
		[{ status: 409, reason: "overridden" }, /закрыто человеком/],
		[{ status: 409, reason: "already_in_state" }, /уже в инбоксе/],
		[{ status: 409, reason: "conflict" }, /одновременное изменение/],
		[{ status: 409, reason: "taken_by_other" }, /взято не тобой/],
		[{ status: 409, reason: "note_required" }, /не отпущено: note_required/],
		[{ status: 403 }, /не участник/],
	];
	for (const [over, pattern] of cases) {
		cloud.state.releaseOverride = over;
		const released = await c.tool("release_intent", { task_id: "intent-1" });
		assert.match(released.text, pattern, released.text);
		assert.equal(cloud.state.views.get("intent-1").intentState, "TAKEN", "состояние не менялось");
	}
});

test("REWORK после возврата: повторный draft того же task_id — отказ с mark_failed, сигнал возврата не стирается", async (t) => {
	const { cloud, c, taskId } = await setupTaken(t);
	assert.equal((await draft(c)).ok, true);
	assert.equal((await c.tool("delegate", { task_id: taskId, executor: "grok" })).ok, true);
	assert.equal((await c.tool("submit_report", { task_id: taskId, report: "отчёт" })).ok, true);
	assert.equal((await c.tool("request_rework", { task_id: taskId, reason: "доделать" })).ok, true);

	cloud.returnToInbox("intent-1", "переделать");
	assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);

	const redraft = await draft(c);
	assert.equal(redraft.ok, false, redraft.text);
	assert.match(redraft.text, /заведена до возврата намерения в инбокс/);
	assert.match(redraft.text, /mark_failed/);
	const events = await eventTypes(c, taskId);
	assert.equal(events.filter((type) => type === "TaskDrafted").length, 1);

	// Отказ не перезаписал увиденный reopenedAt: delegate тоже отказывает.
	const delegated = await c.tool("delegate", { task_id: taskId, executor: "grok" });
	assert.equal(delegated.ok, false, delegated.text);
	assert.match(delegated.text, /больше не твоё/);
	assert.equal((await c.tool("mark_failed", { task_id: taskId, reason: "возвращено" })).ok, true);
});

test("опрос изменений: страница из одинаковых intentUpdatedAt не зацикливает курсор", async (t) => {
	const cloud = await startIntentCloud(t, {
		intents: [{ id: "one" }, { id: "two" }, { id: "three" }, { id: "four" }],
		changesLimit: 2,
	});
	const c = startMcp(
		t,
		mcpEnv(tmpDir(), cloud.baseUrl, {
			ACTARI_INTENT_POLL_MS: "100",
			ACTARI_CHANGES_PAGE: "2",
		}),
	);
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	for (const id of ["one", "two", "three", "four"]) {
		assert.equal((await c.tool("take", { task_id: id })).ok, true);
	}
	// Массовое изменение одним моментом (как применение плана), и одно позже.
	const tie = new Date(Date.now() + 2000).toISOString();
	for (const id of ["one", "two", "three"]) {
		const view = cloud.state.views.get(id);
		Object.assign(view, { priority: "HIGH", intentUpdatedAt: tie });
	}
	const later = cloud.state.views.get("four");
	Object.assign(later, {
		priority: "LOW",
		intentUpdatedAt: new Date(Date.now() + 3000).toISOString(),
	});

	let text = "";
	const arrived = await waitFor(async () => {
		text = (await c.tool("list_tasks")).text;
		return text.includes("(four)");
	});
	assert.ok(arrived, `изменение после группы ничьих не пришло: ${text}`);
	const queries = cloud.state.changesQueries;
	const repeats = queries.filter(
		(since, index) => index > 0 && since === queries[index - 1],
	).length;
	assert.ok(repeats <= 3, `курсор топчется на месте: ${repeats} повторов из ${queries.length}`);
});
