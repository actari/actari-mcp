// feature_questions / answer_question (спека 2026-10-20 feature-questions §4, §6):
// агент читает вопросы AI-продакта по фиче (project, slug) и отвечает в ветку
// вопроса. Ответ подписывается владельцем токена с пометкой «через MCP».

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	SCHEMA,
	WS,
	cleanEnv,
	mcpEnv,
	startIntentCloud,
	startMcp,
} from "./support/intent-cloud.mjs";

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-feature-questions-"));

const ARGS = { project: "demo", slug: "brief-one" };
const ANSWER_ARGS = { ...ARGS, question_id: "q-1", text: "Да, считаем по UTC" };

const FEATURE_QUESTIONS = {
	feature: { id: "f-1", title: "Прогноз", url: "https://cloud.test/features/f-1" },
	questions: [
		{
			id: "q-1",
			status: "OPEN",
			text: "В какой зоне считаем дни?",
			url: "https://cloud.test/features/f-1#question-q-1",
			thread: [
				{
					author: "Лид",
					source: "USER",
					body: "Уточни зону",
					createdAt: "2026-10-20T10:00:00.000Z",
				},
				{
					author: "Алексей",
					source: "MCP",
					body: "Пока не знаю",
					createdAt: "2026-10-20T10:05:00.000Z",
				},
				{
					author: "Лид",
					source: "TELEGRAM",
					body: "Смотри бриф",
					createdAt: "2026-10-20T10:06:00.000Z",
				},
				{
					author: "Лид",
					source: "AI_PRODUCT",
					body: "А что с летним временем?",
					createdAt: "2026-10-20T10:07:00.000Z",
				},
			],
		},
		{
			id: "q-2",
			status: "ANSWERED",
			text: "Нужен ли экспорт?",
			url: "https://cloud.test/features/f-1#question-q-2",
			thread: [],
		},
		{
			id: "q-3",
			status: "WITHDRAWN",
			text: "Старый вопрос",
			url: "https://cloud.test/features/f-1#question-q-3",
			thread: [],
		},
	],
};

async function setup(t, { cloudOptions = {}, bind = true, dir = tmpDir() } = {}) {
	const cloud = await startIntentCloud(t, cloudOptions);
	const c = startMcp(t, mcpEnv(dir, cloud.baseUrl));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		...(bind ? { cloud_workspace_id: WS.id } : {}),
	});
	return { cloud, c };
}

test("tools/list: оба инструмента, описания на русском, подпись «через MCP»", async (t) => {
	const { c } = await setup(t);
	const tools = (await c.call("tools/list", {})).result.tools;
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	for (const name of ["feature_questions", "answer_question"]) {
		const tool = byName.get(name);
		assert.ok(tool, `${name} в tools/list`);
		assert.match(tool.description, /[а-яё]{4,}/i, `${name}: описание на русском`);
	}
	assert.deepEqual(byName.get("feature_questions").inputSchema.required, ["project", "slug"]);
	assert.deepEqual(byName.get("answer_question").inputSchema.required, [
		"project",
		"slug",
		"question_id",
		"text",
	]);
	assert.ok(
		byName
			.get("answer_question")
			.description.includes("подписывается владельцем токена с пометкой «через MCP»"),
		byName.get("answer_question").description,
	);
});

test("feature_questions: вопросы с id, статусом по-русски, ссылкой и веткой", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { featureQuestions: FEATURE_QUESTIONS } });
	const res = await c.tool("feature_questions", ARGS);
	assert.equal(res.ok, true, res.text);
	assert.deepEqual(cloud.state.questionQueries, [
		{ workspaceId: WS.id, project: "demo", slug: "brief-one" },
	]);
	assert.match(res.text, /Прогноз/);
	assert.match(res.text, /q-1.*открыт/);
	assert.match(res.text, /q-2.*отвечен/);
	assert.match(res.text, /q-3.*снят/);
	assert.match(res.text, /В какой зоне считаем дни\?/);
	assert.match(res.text, /https:\/\/cloud\.test\/features\/f-1#question-q-1/);
	assert.match(res.text, /Лид: Уточни зону/);
	assert.match(res.text, /Алексей \(через MCP\): Пока не знаю/);
	assert.match(res.text, /Лид \(через Telegram\): Смотри бриф/);
	assert.match(res.text, /AI-продакт: А что с летним временем\?/);
});

test("feature_questions: у фичи нет вопросов — так и пишет", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { featureQuestions: { feature: FEATURE_QUESTIONS.feature, questions: [] } },
	});
	const res = await c.tool("feature_questions", ARGS);
	assert.equal(res.ok, true, res.text);
	assert.match(res.text, /нет вопросов/);
});

test("feature_questions: 404 — reason от облака", async (t) => {
	const { c } = await setup(t, { cloudOptions: { featureQuestions: null } });
	const res = await c.tool("feature_questions", ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /Фича demo\/brief-one не найдена/);
});

test("feature_questions: 403 — нет доступа к пространству", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: {
			questionsOverride: { status: 403, body: { error: "Not a member of this workspace" } },
		},
	});
	const res = await c.tool("feature_questions", ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /нет доступа к пространству ws-alpha/);
});

test("feature_questions: облако недоступно (503) — ошибка без падения", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { questionsOverride: { status: 503, body: { error: "maintenance" } } },
	});
	const res = await c.tool("feature_questions", ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако недоступно: HTTP 503/);
});

test("проект без cloud_workspace_id — понятная ошибка, в облако не ходим", async (t) => {
	const { c, cloud } = await setup(t, { bind: false });
	for (const [name, args] of [
		["feature_questions", ARGS],
		["answer_question", ANSWER_ARGS],
	]) {
		const res = await c.tool(name, args);
		assert.equal(res.ok, false, res.text);
		assert.match(
			res.text,
			/проект demo не привязан к облаку \(register_project с cloud_workspace_id или sync_scope\)/,
		);
	}
	assert.deepEqual(cloud.state.questionQueries, []);
	assert.deepEqual(cloud.state.answers, []);
});

test("нет конфига синка — отказ", async (t) => {
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	for (const [name, args] of [
		["feature_questions", ARGS],
		["answer_question", ANSWER_ARGS],
	]) {
		const res = await c.tool(name, args);
		assert.equal(res.ok, false, res.text);
		assert.match(res.text, /облако не настроено/);
	}
});

test("answer_question: шлёт тело контракта и печатает подтверждение", async (t) => {
	const { c, cloud } = await setup(t);
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, true, res.text);
	assert.deepEqual(cloud.state.answers, [
		{
			workspaceId: WS.id,
			project: "demo",
			slug: "brief-one",
			questionId: "q-1",
			text: "Да, считаем по UTC",
		},
	]);
	assert.match(res.text, /Ответ записан в ветку вопроса q-1, статус: отвечен/);
});

test("answer_question: 409 «вопрос снят» — ok:false и reason в тексте", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { answerStatus: 409, answerBody: { reason: "Вопрос снят — ответ не записан" } },
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /Вопрос снят — ответ не записан/);
});

test("answer_question: 409 «чужой вопрос» — reason в тексте", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { answerStatus: 409, answerBody: { reason: "Вопрос не из этой фичи" } },
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /Вопрос не из этой фичи/);
});

test("answer_question: 404 — reason от облака", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: {
			answerStatus: 404,
			answerBody: { error: "Feature not found", reason: "Фича demo/brief-one не найдена" },
		},
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /Фича demo\/brief-one не найдена/);
});

test("answer_question: 403 — нет членства в пространстве", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { answerStatus: 403, answerBody: { error: "Not a member of this workspace" } },
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /нет доступа к пространству ws-alpha/);
});

test("answer_question: 400 — первая проблема из issues", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: {
			answerStatus: 400,
			answerBody: {
				error: "Invalid input",
				issues: [{ path: ["text"], message: "Слишком длинный ответ" }],
			},
		},
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /text: Слишком длинный ответ/);
});

test("answer_question: облако недоступно (503) — ошибка без падения", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { answerStatus: 503, answerBody: { error: "maintenance" } },
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако недоступно: HTTP 503/);
});

test("answer_question: старое облако без маршрута (404 Unknown endpoint)", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { answerStatus: 404, answerBody: { error: "Unknown endpoint" } },
	});
	const res = await c.tool("answer_question", ANSWER_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако не поддерживает answer_question/);
});

test("answer_question: без обязательных аргументов — вызов отклонён до облака", async (t) => {
	const { c, cloud } = await setup(t);
	const res = await c.tool("answer_question", { project: "demo", slug: "brief-one" });
	assert.equal(res.ok, false, res.text);
	assert.deepEqual(cloud.state.answers, []);
});
