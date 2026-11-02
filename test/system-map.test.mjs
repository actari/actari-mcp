// system_map (спека system-map §6): агент читает карту системы пространства — уровень, элемент
// со связями или поиск — через GET /api/mcp/read/system-map. Облако подменено фейком.

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

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-system-map-"));

const CONTAINERS_TEXT = "## Backend API [backend_api] — контейнер\nТехнологии: .NET 10";
const ELEMENT_TEXT = "## Backend API [backend_api] — контейнер\nСвязи:\n← Мобилка [mobile]: REST";

function fakeMap(query) {
	if (query.element === "backend_api") return { text: ELEMENT_TEXT };
	if (query.level === "container") return { text: CONTAINERS_TEXT };
	return { text: "## Система [system] — система" };
}

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

test("tools/list: system_map со схемой, описание по-русски, level — перечисление", async (t) => {
	const { c } = await setup(t);
	const tools = (await c.call("tools/list", {})).result.tools;
	const tool = tools.find((item) => item.name === "system_map");
	assert.ok(tool, "system_map в tools/list");
	assert.match(tool.description, /[а-яё]{4,}/i);
	assert.deepEqual(tool.inputSchema.required, ["project"]);
	assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
		"element",
		"level",
		"project",
		"query",
	]);
	assert.deepEqual(tool.inputSchema.properties.level.enum, [
		"context",
		"container",
		"component",
		"entity",
	]);
});

test("system_map: уровень — текст контейнеров от облака, запрос несёт пространство проекта", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { systemMap: fakeMap } });
	const res = await c.tool("system_map", { project: "demo", level: "container" });
	assert.equal(res.ok, true, res.text);
	assert.equal(res.text, CONTAINERS_TEXT);
	assert.deepEqual(cloud.state.systemMapQueries, [
		{ project: "demo", workspaceId: WS.id, level: "container" },
	]);
});

test("system_map: элемент со связями", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { systemMap: fakeMap } });
	const res = await c.tool("system_map", { project: "demo", element: "backend_api" });
	assert.equal(res.ok, true, res.text);
	assert.match(res.text, /← Мобилка \[mobile\]: REST/);
	assert.equal(cloud.state.systemMapQueries[0].element, "backend_api");
});

test("system_map: query передаётся как есть", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { systemMap: fakeMap } });
	const res = await c.tool("system_map", { project: "demo", query: "как устроена автовалидация?" });
	assert.equal(res.ok, true, res.text);
	assert.equal(cloud.state.systemMapQueries[0].query, "как устроена автовалидация?");
});

test("system_map: неизвестный level — отказ без запроса в облако", async (t) => {
	const { c, cloud } = await setup(t, { cloudOptions: { systemMap: fakeMap } });
	const res = await c.tool("system_map", { project: "demo", level: "galaxy" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /level/);
	assert.deepEqual(cloud.state.systemMapQueries, []);
});

test("system_map: 404 «not found» — проект или пространство недоступны", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { systemMapOverride: { status: 404, body: { error: "not found" } } },
	});
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /проект demo не найден в облаке/);
});

test("system_map: 404 без тела роута — старое облако без инструмента", async (t) => {
	const { c } = await setup(t, { cloudOptions: { systemMap: null } });
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако не поддерживает system_map/);
});

test("system_map: 409 — проект в двух пространствах, список slug", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: {
			systemMapOverride: {
				status: 409,
				body: { error: "ambiguous project", workspaces: ["alpha", "beta"] },
			},
		},
	});
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /alpha, beta/);
});

test("system_map: 403 — нет доступа к пространству", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { systemMapOverride: { status: 403, body: { error: "forbidden" } } },
	});
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /нет доступа к пространству ws-alpha/);
});

test("system_map: облако недоступно (503) — текст ошибки, без исключения", async (t) => {
	const { c } = await setup(t, {
		cloudOptions: { systemMapOverride: { status: 503, body: { error: "maintenance" } } },
	});
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако недоступно: HTTP 503/);
});

test("system_map: проект без cloud_workspace_id — понятная ошибка, в облако не ходим", async (t) => {
	const { c, cloud } = await setup(t, { bind: false });
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(
		res.text,
		/проект demo не привязан к облаку \(register_project с cloud_workspace_id или sync_scope\)/,
	);
	assert.deepEqual(cloud.state.systemMapQueries, []);
});

test("system_map: нет конфига синка — отказ", async (t) => {
	const dir = tmpDir();
	const c = startMcp(t, cleanEnv({ ACTARI_DB: join(dir, "journal.db"), ACTARI_SCHEMA: SCHEMA }));
	await c.tool("register_project", {
		name: "demo",
		root_path: "/tmp/demo",
		cloud_workspace_id: WS.id,
	});
	const res = await c.tool("system_map", { project: "demo" });
	assert.equal(res.ok, false, res.text);
	assert.match(res.text, /облако не настроено/);
});

test("system_map: инструкции сервера упоминают инструмент", async (t) => {
	const { c } = await setup(t);
	const init = await c.call("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	});
	assert.match(init.result.instructions, /system_map/);
});
