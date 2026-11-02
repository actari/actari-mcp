// architecture_review / architecture_check (спека ai-architect §5): агент получает разбор фичи по slug
// или по тексту брифа и действующие ADR для приёмки. Облако подменено фейком.

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

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-architecture-"));

const REVIEW_TEXT =
	"Разбор архитектора (актуален)\n\n## Затронуто\n- Файлы [files] — компонент\n\n## Вопросы архитектора\n- [открыт] Нужен ли транскодер? (id: q-1)";
const DRAFT_TEXT = "Разбор архитектора (черновик)\n\n## Затронуто\n- Файлы [files] — компонент";
const CHECK_TEXT =
	"Проверка по архитектуре: Видео (demo/2026-11-02-video-1)\n\n## Действующие решения (1)\n- Подписанные ссылки (adr:a1)\n  Искать в диффе: SignedFileLink";

const fakeArchitecture = {
	review: (query) => ({ status: "ok", text: `${REVIEW_TEXT}\n(${query.slug})` }),
	reviewText: () => ({ status: "ok", text: DRAFT_TEXT }),
	check: () => ({ status: "ok", text: CHECK_TEXT }),
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

const sent = (cloud) =>
	cloud.state.architectureQueries.review.length +
	cloud.state.architectureQueries.reviewText.length +
	cloud.state.architectureQueries.check.length;

test("tools/list: оба инструмента со схемами, описание по-русски", async (t) => {
	const { c } = await setup(t);
	const tools = (await c.call("tools/list", {})).result.tools;
	const review = tools.find((item) => item.name === "architecture_review");
	const check = tools.find((item) => item.name === "architecture_check");
	assert.ok(review && check, "оба инструмента в tools/list");
	assert.match(review.description, /[а-яё]{4,}/i);
	assert.deepEqual(review.inputSchema.required, ["project"]);
	assert.deepEqual(Object.keys(review.inputSchema.properties).sort(), [
		"project",
		"slug",
		"text",
		"title",
	]);
	assert.deepEqual(check.inputSchema.required, ["task_id"]);
});

test("architecture_review { project, slug }: GET с пространством проекта, текст как есть", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { architecture: fakeArchitecture } });
	const res = await c.tool("architecture_review", { project: "demo", slug: "video" });
	assert.equal(res.ok, true, res.text);
	assert.match(res.text, /\(id: q-1\)/);
	assert.match(res.text, /\(video\)$/);
	assert.deepEqual(cloud.state.architectureQueries.review, [
		{ project: "demo", workspaceId: WS.id, slug: "video" },
	]);
	assert.equal(cloud.state.architectureQueries.reviewText.length, 0);
});

test("architecture_review { project, text, title }: POST с телом, текст как есть", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { architecture: fakeArchitecture } });
	const res = await c.tool("architecture_review", {
		project: "demo",
		text: "Бриф про видео",
		title: "Видео",
	});
	assert.equal(res.ok, true, res.text);
	assert.equal(res.text, DRAFT_TEXT);
	assert.deepEqual(cloud.state.architectureQueries.reviewText, [
		{ workspaceId: WS.id, project: "demo", text: "Бриф про видео", title: "Видео" },
	]);
	assert.equal(cloud.state.architectureQueries.review.length, 0);
});

test("architecture_review: оба параметра или ни одного — ошибка без запроса в облако", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { architecture: fakeArchitecture } });
	const both = await c.tool("architecture_review", { project: "demo", slug: "video", text: "x" });
	assert.equal(both.ok, false, both.text);
	assert.match(both.text, /либо slug, либо text/);
	const none = await c.tool("architecture_review", { project: "demo" });
	assert.equal(none.ok, false, none.text);
	assert.match(none.text, /ровно один из параметров/);
	const blank = await c.tool("architecture_review", { project: "demo", text: "   " });
	assert.equal(blank.ok, false, blank.text);
	assert.equal(sent(cloud), 0);
});

test("architecture_review: queued и no_map — понятный текст облака, не ошибка", async (t) => {
	const queued = "Разбор архитектора поставлен в очередь — повторите через минуту.";
	const noMap = "Карты системы пока нет — соберите её на странице «Система».";
	const { c } = await setup(t, {
		cloudOptions: {
			architecture: {
				review: (query) =>
					query.slug === "fresh"
						? { status: "queued", text: queued }
						: { status: "no_map", text: noMap },
			},
		},
	});
	const first = await c.tool("architecture_review", { project: "demo", slug: "fresh" });
	assert.equal(first.ok, true, first.text);
	assert.equal(first.text, queued);
	const second = await c.tool("architecture_review", { project: "demo", slug: "other" });
	assert.equal(second.ok, true, second.text);
	assert.equal(second.text, noMap);
});

test("architecture_review: 5xx облака — текст «Архитектура: …», не ошибка протокола", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { architectureOverride: { status: 503, body: { error: "maintenance" } } },
	});
	const res = await c.tool("architecture_review", { project: "demo", slug: "video" });
	assert.equal(res.ok, true, res.text);
	assert.match(
		res.text,
		/^Архитектура: облако недоступно: HTTP 503; повторите architecture_review позже/,
	);
});

test("architecture_review: 404 фичи, 404 проекта, 404 без роута, 409, 403, 400 — понятные тексты", async (t) => {
	const cases = [
		[
			{
				status: 404,
				body: { error: "Feature not found", reason: "Фича demo/nope не найдена в облаке." },
			},
			/Фича demo\/nope не найдена в облаке/,
		],
		[{ status: 404, body: { error: "not found" } }, /проект demo не найден в облаке/],
		[
			{ status: 404, body: { error: "Unknown endpoint" } },
			/облако не поддерживает architecture_review/,
		],
		[
			{ status: 409, body: { error: "ambiguous project", workspaces: ["alpha", "beta"] } },
			/alpha, beta/,
		],
		[
			{ status: 403, body: { error: "read-only token" } },
			/нет доступа к architecture_review \(403\)/,
		],
		[
			{ status: 400, body: { error: "Missing slug" } },
			/облако отклонило architecture_review: Missing slug/,
		],
	];
	for (const [override, pattern] of cases) {
		const { c } = await setup(t, { cloudOptions: { architectureOverride: override } });
		const res = await c.tool("architecture_review", { project: "demo", slug: "nope" });
		assert.equal(res.ok, true, res.text);
		assert.match(res.text, /^Архитектура: /);
		assert.match(res.text, pattern);
	}
});

test("architecture_review: проект без cloud_workspace_id и нет конфига синка — текст, в облако не ходим", async (t) => {
	const unbound = await setup(t, { bind: false, cloudOptions: { architecture: fakeArchitecture } });
	const res = await unbound.c.tool("architecture_review", { project: "demo", slug: "video" });
	assert.equal(res.ok, true, res.text);
	assert.match(res.text, /^Архитектура: проект demo не привязан к облаку/);
	assert.equal(sent(unbound.cloud), 0);

	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	const noCloud = await c.tool("architecture_review", { project: "demo", slug: "video" });
	assert.equal(noCloud.ok, true, noCloud.text);
	assert.match(noCloud.text, /^Архитектура: облако не настроено/);
});

test("architecture_check { task_id }: проект из префикса, GET с task_id", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { architecture: fakeArchitecture } });
	const res = await c.tool("architecture_check", { task_id: "demo/2026-11-02-video-1" });
	assert.equal(res.ok, true, res.text);
	assert.equal(res.text, CHECK_TEXT);
	assert.match(res.text, /Искать в диффе: SignedFileLink/);
	assert.deepEqual(cloud.state.architectureQueries.check, [
		{ project: "demo", workspaceId: WS.id, task_id: "demo/2026-11-02-video-1" },
	]);
});

test("architecture_check: task_id без префикса проекта — ошибка без запроса; задача не найдена — текст", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { architecture: fakeArchitecture } });
	const bad = await c.tool("architecture_check", { task_id: "no-slash" });
	assert.equal(bad.ok, false, bad.text);
	assert.match(bad.text, /project\/дата-slug/);
	assert.equal(sent(cloud), 0);

	const missing = await setup(t, {
		cloudOptions: {
			architectureOverride: {
				status: 404,
				body: { error: "Task not found", reason: "Задача demo/x не найдена в облаке." },
			},
		},
	});
	const res = await missing.c.tool("architecture_check", { task_id: "demo/x" });
	assert.equal(res.ok, true, res.text);
	assert.equal(res.text, "Архитектура: Задача demo/x не найдена в облаке.");
});

test("architecture_check: проект из префикса не зарегистрирован — текст с причиной", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { architecture: fakeArchitecture } });
	const res = await c.tool("architecture_check", { task_id: "ghost/2026-11-02-x-1" });
	assert.equal(res.ok, true, res.text);
	assert.match(res.text, /^Архитектура: Проект "ghost" не зарегистрирован/);
	assert.equal(sent(cloud), 0);
});

test("feature_questions: показывает роль вопроса — «архитектор» и «продакт»", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: {
			featureQuestions: {
				feature: { id: "f-1", title: "Видео", url: "https://cloud.test/features/f-1" },
				questions: [
					{
						id: "q-1",
						status: "OPEN",
						role: "ARCHITECT",
						text: "Нужен ли транскодер?",
						thread: [],
					},
					{ id: "q-2", status: "ANSWERED", role: "PRODUCT", text: "Какой формат?", thread: [] },
					{ id: "q-3", status: "OPEN", text: "Без роли", thread: [] },
				],
			},
		},
	});
	const res = await c.tool("feature_questions", { project: "demo", slug: "video" });
	assert.equal(res.ok, true, res.text);
	assert.match(res.text, /Вопрос q-1 — открыт, архитектор/);
	assert.match(res.text, /Вопрос q-2 — отвечен, продакт/);
	assert.match(res.text, /Вопрос q-3 — открыт\n/);
});

test("инструкции сервера упоминают архитектора и оба инструмента", async (t) => {
	const { c } = await setup(t);
	const init = await c.call("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	});
	assert.match(init.result.instructions, /architecture_review/);
	assert.match(init.result.instructions, /architecture_check/);
});
