// publish_intent (спека 2026-09-25 §3–4): бриф из локального флоу публикует
// в облаке фичу и намерение по ключу (project, slug); повтор обновляет,
// дублей нет, карточку закрытую вручную — не пересоздаёт.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	SCHEMA,
	WS,
	cleanEnv,
	mcpEnv,
	startIntentCloud,
	startMcp,
} from "./support/intent-cloud.mjs";
import { formatPublishRejection, formatPublishResult } from "../intent.mjs";

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-publish-intent-"));

const BASE_ARGS = {
	project: "demo",
	slug: "brief-one",
	title: "Фича из флоу",
	text: "Бриф v1",
	acceptance_criteria: "- раз",
};

async function setup(t, { cloudOptions = {}, bind = true, env = {}, dir = tmpDir() } = {}) {
	const cloud = await startIntentCloud(t, cloudOptions);
	const c = startMcp(t, mcpEnv(dir, cloud.baseUrl, env));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		...(bind ? { cloud_workspace_id: WS.id } : {}),
	});
	return { cloud, c, dir };
}

test("tools/list содержит publish_intent", async (t) => {
	const { c } = await setup(t);
	const res = await c.call("tools/list", {});
	const names = res.result.tools.map((tool) => tool.name);
	assert.ok(names.includes("publish_intent"), names.join(", "));
});

test("проект не привязан к облаку — отказ, локальный флоу продолжается", async (t) => {
	const { c, cloud } = await setup(t, { bind: false });
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(
		res.text,
		/проект demo не привязан к облаку \(register_project с cloud_workspace_id или sync_scope\) — локальный флоу продолжается/,
	);
	assert.deepEqual(cloud.state.publishes, []);
});

test("нет конфига синка — отказ", async (t) => {
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(
		res.text,
		/облако не настроено \(нет sync\.json \/ token\) — локальный флоу продолжается/,
	);
});

test("незарегистрированный проект — отказ", async (t) => {
	const cloud = await startIntentCloud(t);
	const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /не зарегистрирован/);
});

test("облако недоступно — отказ, бриф локально записан", async (t) => {
	const { c, cloud } = await setup(t);
	cloud.state.down = true;
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(
		res.text,
		/облако недоступно: HTTP 503; повторите publish_intent позже — бриф локально записан/,
	);
});

test("старый сервер без маршрута intents — отказ", async (t) => {
	const { c } = await setup(t, { cloudOptions: { intentsRoute: false } });
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако не поддерживает publish_intent \(старая версия сервера\)/);
});

test("409 closed_manually — карточку не пересоздаём", async (t) => {
	const { c, cloud } = await setup(t);
	cloud.state.publishOverride = {
		reason: "closed_manually",
		intent: { id: "intent-x", title: "Старое" },
	};
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /закрыли вручную/);
	assert.match(res.text, /новую не создаю/);
});

test("409 key_taken — ключ занят другим намерением", async (t) => {
	const { c, cloud } = await setup(t);
	cloud.state.publishOverride = { reason: "key_taken", intent: { id: "intent-y", title: "Чужое" } };
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /demo\/brief-one уже занят другим намерением intent-y/);
});

test("403 во всех целях синка — отказ «нет доступа»", async (t) => {
	const { c, cloud } = await setup(t);
	cloud.state.publishOverride = { status: 403 };
	const res = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, new RegExp(`нет доступа к пространству ${WS.id}`));
});

test("created → повтор unchanged → правка критериев updated", async (t) => {
	const { c, cloud } = await setup(t);
	const created = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(created.ok, true, created.text);
	assert.match(created.text, /^намерение intent-pub-1 \(created\), фича f-pub-1, критерии v1/);
	assert.match(created.text, /дальше: \/feature → take intent-pub-1/);
	assert.deepEqual(cloud.state.publishes[0], {
		workspaceId: WS.id,
		project: "demo",
		slug: "brief-one",
		title: BASE_ARGS.title,
		text: "Бриф v1",
		acceptanceCriteria: "- раз",
		intentTaskId: null,
	});

	const repeat = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(repeat.ok, true, repeat.text);
	assert.match(repeat.text, /\(unchanged\)/);

	const updated = await c.tool("publish_intent", {
		...BASE_ARGS,
		acceptance_criteria: "- раз\n- два",
	});
	assert.equal(updated.ok, true, updated.text);
	assert.match(updated.text, /\(updated\).*критерии v2/s);
});

test("intent_task_id уходит в тело — bind, неизвестный id — отказ", async (t) => {
	const { c } = await setup(t, { cloudOptions: { intents: [{ id: "intent-1" }] } });
	const bound = await c.tool("publish_intent", { ...BASE_ARGS, intent_task_id: "intent-1" });
	assert.equal(bound.ok, true, bound.text);
	assert.match(bound.text, /намерение intent-1 \(bound\)/);

	const missing = await c.tool("publish_intent", { ...BASE_ARGS, intent_task_id: "nope" });
	assert.equal(missing.ok, false, missing.text);
	assert.match(missing.text, /намерение nope не найдено в облаке/);
});

test("кэш вида пишется, критерии увидены", async (t) => {
	const { c, dir } = await setup(t);
	const created = await c.tool("publish_intent", BASE_ARGS);
	assert.equal(created.ok, true, created.text);
	const sqlite = new DatabaseSync(join(dir, "journal.db"));
	t.after(() => sqlite.close());
	const row = sqlite
		.prepare(
			"SELECT seen_criteria_version, seen_criteria, workspace_id FROM intent_cache WHERE intent_task_id = ?",
		)
		.get("intent-pub-1");
	assert.equal(row.seen_criteria_version, 1);
	assert.equal(row.seen_criteria, "- раз");
	assert.equal(row.workspace_id, WS.id);
});

// ============ юнит-проверки текстов (без процесса сервера) ============

test("formatPublishResult — точная строка", () => {
	const text = formatPublishResult({
		intentId: "intent-1",
		outcome: "created",
		featureId: "f-1",
		criteriaVersion: 1,
	});
	assert.equal(
		text,
		"намерение intent-1 (created), фича f-1, критерии v1\nдальше: /feature → take intent-1",
	);
});

test("formatPublishRejection — key_taken, closed_manually, неизвестная причина", () => {
	assert.match(
		formatPublishRejection(
			{ project: "demo", slug: "brief-one" },
			{ reason: "key_taken", intent: { id: "intent-y", title: "Чужое" } },
		),
		/demo\/brief-one уже занят другим намерением intent-y/,
	);
	assert.match(
		formatPublishRejection(
			{ project: "demo", slug: "brief-one" },
			{ reason: "closed_manually", intent: { id: "intent-x" } },
		),
		/карточку intent-x закрыли вручную в облаке — новую не создаю/,
	);
	assert.match(
		formatPublishRejection({ project: "demo", slug: "brief-one" }, { reason: "something_else" }),
		/облако отказало: something_else/,
	);
});
