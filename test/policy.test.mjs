// Тесты политик журнала и переноса базы: спавним server.mjs с временной
// базой и говорим по JSON-RPC через stdio; облако — мок на node:http.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
	LENIENT_POLICY,
	applyWorkspacePolicies,
	pickStartupPolicy,
	policyConfigPath,
	readPolicyFile,
	renderArtifactTitle,
	renderToolDescription,
	resolvePolicy,
	validatePolicyBody,
	writePolicyFile,
} from "../policy.mjs";
import { policyUrlFromBase } from "../sync.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");
const SCHEMA = join(ROOT, "schema.sql");

// env без унаследованных ACTARI_* — окружение машины не должно влиять
function cleanEnv(extra = {}) {
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("ACTARI_")) delete env[k];
	return { ...env, ACTARI_SCHEMA: SCHEMA, ...extra };
}

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "actari-policy-test-"));
}

// Минимальный MCP-клиент; stop() дожидается выхода процесса — файл базы
// должен быть отпущен до того, как тест откроет его сам.
function startClient(t, { dbPath, env = {} }) {
	const child = spawn(process.execPath, [SERVER], {
		env: cleanEnv({ ACTARI_DB: dbPath, ...env }),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c) => (stderr += c));
	const exited = new Promise((r) => child.on("exit", r));
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
		if (msg.result.isError) return { ok: false, error: text };
		try {
			return { ok: true, data: JSON.parse(text), text };
		} catch {
			return { ok: true, text };
		}
	};
	const stop = async () => {
		child.kill();
		await exited;
	};
	return { call, tool, stop, getStderr: () => stderr };
}

async function reg(c, name, extra = {}) {
	const r = await c.tool("register_project", { name, root_path: `/tmp/${name}`, ...extra });
	assert.ok(r.ok, r.error);
}

// Полный цикл до ACCEPTED — заготовка для переноса и enforcement.
async function fullCycle(c, project, taskId, { evidence = "abc1234" } = {}) {
	await c.tool("draft_task", { task_id: taskId, project, title: "т", task_text: "x" });
	await c.tool("delegate", { task_id: taskId, executor: "grok" });
	await c.tool("submit_report", { task_id: taskId, report: "падал -> прошёл" });
	return c.tool("accept", { task_id: taskId, evidence });
}

// ============ перенос старой схемы ============

test("перенос: база с verify_commit переигрывается в новую схему, бэкап рядом", async (t) => {
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");

	// 1) Наполняем базу через сам сервер (новая схема)
	let c = startClient(t, { dbPath });
	await reg(c, "old");
	await c.tool("record_artifact", {
		project: "old",
		kind: "spec",
		title: "Project baseline: old",
		body: "412/412",
	});
	await fullCycle(c, "old", "old/t1");
	await c.tool("record_incident", { task_id: "old/t1", description: "грабли", lesson: "урок" });
	await c.stop();

	// 2) Имитируем старую схему: колонка проекции и ключ payload — verify_commit.
	// events_no_update блокирует UPDATE (план это не учёл) — для фикстуры снимаем.
	const legacy = new DatabaseSync(dbPath);
	legacy.exec("ALTER TABLE tasks RENAME COLUMN evidence TO verify_commit");
	legacy.exec("DROP TRIGGER events_no_update");
	legacy.exec(
		"UPDATE events SET payload = json_set(json_remove(payload, '$.evidence'), '$.verify_commit', 'abc1234') WHERE type = 'Accepted'",
	);
	const seqBefore = legacy
		.prepare("SELECT seq FROM events ORDER BY seq")
		.all()
		.map((r) => r.seq);
	legacy.close();

	// 3) Новый старт → перенос
	c = startClient(t, { dbPath });
	const task = await c.tool("get_task", { task_id: "old/t1" });
	assert.ok(task.ok, task.error);
	assert.equal(task.data.task.status, "ACCEPTED");
	assert.equal(task.data.task.evidence, "abc1234", "verify_commit из payload стал evidence");
	assert.equal(task.data.events.filter((e) => e.type === "Accepted").length, 1);

	const arts = await c.tool("list_artifacts", { project: "old" });
	assert.equal(arts.data.length, 1, "артефакт пересобран из событий");
	const found = await c.tool("search_precedents", { query: "грабли" });
	assert.equal(found.data.incidents.length, 1, "инцидент пересобран из событий");

	assert.match(c.getStderr(), /перенесено \d+ событий/);
	const backups = readdirSync(dir).filter((f) => f.startsWith("journal.db.") && f.endsWith(".bak"));
	assert.equal(backups.length, 1, "бэкап лежит рядом");

	await c.stop();
	const fresh = new DatabaseSync(dbPath, { readOnly: true });
	const seqAfter = fresh
		.prepare("SELECT seq FROM events ORDER BY seq")
		.all()
		.map((r) => r.seq);
	assert.deepEqual(seqAfter, seqBefore, "seq сохранены — курсоры синка не ломаются");
	assert.equal(
		JSON.parse(fresh.prepare("SELECT payload FROM events WHERE type = 'Accepted'").get().payload)
			.verify_commit,
		undefined,
	);
	fresh.close();
});

test("перенос: старая схема без Dropped в CHECK переигрывается", async (t) => {
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");

	// 1) База по схеме без 'Dropped' в CHECK — имитация версии до этой фичи.
	const legacySchema = readFileSync(SCHEMA, "utf8").replace(
		"                'Dropped',          -- payload: reason\n",
		"",
	);
	assert.ok(
		!legacySchema.includes("'Dropped',          -- payload: reason"),
		"строка Dropped вырезана из CHECK",
	);
	const legacy = new DatabaseSync(dbPath);
	legacy.exec(legacySchema);
	// Проект — событием ProjectRegistered (не напрямую в проекцию): переигрывание
	// строит фрешовую базу только из events, прямая вставка в projects не
	// переживёт replay и обвалит guard_project_registered на TaskDrafted.
	const insertEvent = legacy.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)");
	insertEvent.run(
		"_general",
		"ProjectRegistered",
		JSON.stringify({ name: "old", root_path: "/tmp/old" }),
	);
	insertEvent.run(
		"old/t1",
		"TaskDrafted",
		JSON.stringify({ project: "old", title: "т1", task_text: "x" }),
	);
	insertEvent.run(
		"old/t2",
		"TaskDrafted",
		JSON.stringify({ project: "old", title: "т2", task_text: "y" }),
	);
	insertEvent.run(
		"_general",
		"ArtifactRecorded",
		JSON.stringify({ project: "old", kind: "note", title: "заметка", body: "текст" }),
	);
	const before = {
		events: legacy.prepare("SELECT count(*) AS n FROM events").get().n,
		tasks: legacy.prepare("SELECT count(*) AS n FROM tasks").get().n,
	};
	legacy.close();

	// 2) Новый старт — детектор по тексту DDL events замечает отсутствие Dropped
	const c = startClient(t, { dbPath });
	const list = await c.tool("list_tasks", { project: "old" });
	assert.ok(list.ok, list.error);
	assert.equal(list.data.length, before.tasks);

	assert.match(c.getStderr(), new RegExp(`перенесено ${before.events} событий`));
	const backups = readdirSync(dir).filter((f) => f.startsWith("journal.db.") && f.endsWith(".bak"));
	assert.equal(backups.length, 1, "бэкап лежит рядом");

	const drop = await c.tool("drop_task", { task_id: "old/t2", reason: "устарело" });
	assert.ok(drop.ok, drop.error);
	assert.equal(drop.data.status, "DROPPED");

	await c.stop();
	const after = (() => {
		const fresh = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return {
				events: fresh.prepare("SELECT count(*) AS n FROM events").get().n,
				tasks: fresh.prepare("SELECT count(*) AS n FROM tasks").get().n,
			};
		} finally {
			fresh.close();
		}
	})();
	// после переноса добавилось ровно одно событие Dropped
	assert.equal(after.events, before.events + 1);
	assert.equal(after.tasks, before.tasks);

	// 3) Второй запуск на уже новой схеме — без повторного переноса
	const c2 = startClient(t, { dbPath });
	await c2.tool("list_tasks", {});
	assert.doesNotMatch(c2.getStderr(), /перенесено/);
	assert.equal(
		readdirSync(dir).filter((f) => f.endsWith(".bak")).length,
		1,
		"новый .bak не появился",
	);
	await c2.stop();
});

test("перенос: старая схема без Released в CHECK переигрывается", async (t) => {
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");

	// 1) База по схеме без 'Released' в CHECK — имитация версии до этой фичи.
	const legacySchema = readFileSync(SCHEMA, "utf8").replace(
		"                'ProjectRegistered', -- payload: name, root_path, cloud_workspace_id\n                'Released'          -- payload: project, items, ref?, summary?\n",
		"                'ProjectRegistered' -- payload: name, root_path, cloud_workspace_id\n",
	);
	assert.ok(
		!legacySchema.includes("'Released'          -- payload: project, items, ref?, summary?"),
		"строка Released вырезана из CHECK",
	);
	const legacy = new DatabaseSync(dbPath);
	legacy.exec(legacySchema);
	const insertEvent = legacy.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)");
	insertEvent.run(
		"_general",
		"ProjectRegistered",
		JSON.stringify({ name: "old", root_path: "/tmp/old" }),
	);
	insertEvent.run(
		"old/t1",
		"TaskDrafted",
		JSON.stringify({ project: "old", title: "т1", task_text: "x" }),
	);
	const before = {
		events: legacy.prepare("SELECT count(*) AS n FROM events").get().n,
		tasks: legacy.prepare("SELECT count(*) AS n FROM tasks").get().n,
	};
	legacy.close();

	// 2) Новый старт — детектор по тексту DDL events замечает отсутствие Released
	const c = startClient(t, { dbPath });
	const list = await c.tool("list_tasks", { project: "old" });
	assert.ok(list.ok, list.error);
	assert.equal(list.data.length, before.tasks);

	assert.match(c.getStderr(), new RegExp(`перенесено ${before.events} событий`));
	const backups = readdirSync(dir).filter((f) => f.startsWith("journal.db.") && f.endsWith(".bak"));
	assert.equal(backups.length, 1, "бэкап лежит рядом");

	// после переноса CHECK принимает Released, и запись проходит
	const release = await c.tool("record_release", { project: "old", items: ["a"] });
	assert.ok(release.ok, release.error);

	await c.stop();
	const after = (() => {
		const fresh = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return {
				events: fresh.prepare("SELECT count(*) AS n FROM events").get().n,
			};
		} finally {
			fresh.close();
		}
	})();
	// после переноса добавилось ровно одно событие Released
	assert.equal(after.events, before.events + 1);
});

test("перенос: база новой схемы не трогается", async (t) => {
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");
	let c = startClient(t, { dbPath });
	await reg(c, "p");
	await c.stop();
	c = startClient(t, { dbPath });
	await reg(c, "q");
	assert.doesNotMatch(c.getStderr(), /перенесено/);
	assert.equal(readdirSync(dir).filter((f) => f.endsWith(".bak")).length, 0);
});

// ============ policy.mjs: чистые функции ============

function strictish(overrides = {}) {
	return {
		schemaVersion: 1,
		name: "Strictish",
		description: "тест",
		enforce: {
			accept_requires_evidence: true,
			draft_requires_artifact: "Project baseline: {project}",
		},
		guidance: { draft: "D", delegate: "", report: "R", accept: "Only after a full run." },
		...overrides,
	};
}

test("validatePolicyBody: валидное тело — без ошибок", () => {
	assert.deepEqual(validatePolicyBody(strictish()), []);
	assert.deepEqual(validatePolicyBody(LENIENT_POLICY), []);
});

test("validatePolicyBody: ловит schemaVersion, {project}, длину guidance, типы", () => {
	assert.match(validatePolicyBody(strictish({ schemaVersion: 2 })).join("\n"), /schemaVersion/);
	assert.match(
		validatePolicyBody(
			strictish({
				enforce: { accept_requires_evidence: true, draft_requires_artifact: "Baseline" },
			}),
		).join("\n"),
		/\{project\}/,
	);
	assert.match(
		validatePolicyBody(
			strictish({ guidance: { draft: "x".repeat(4001), delegate: "", report: "", accept: "" } }),
		).join("\n"),
		/guidance\.draft/,
	);
	assert.match(validatePolicyBody(strictish({ name: "" })).join("\n"), /name/);
	assert.match(validatePolicyBody("nope").join("\n"), /объектом/);
	assert.match(
		validatePolicyBody(strictish({ guidance: { draft: "D", delegate: "", report: "R" } })).join(
			"\n",
		),
		/guidance\.accept/,
	);
});

test("resolvePolicy: облачный проект — только кэш пространства, иначе lenient + warning", () => {
	const file = {
		schemaVersion: 1,
		default: strictish({ name: "Default" }),
		projects: { app: strictish({ name: "Own" }) },
		workspaces: {
			"ws-1": {
				id: "ws-1",
				slug: "acme",
				policyId: "p1",
				version: 2,
				body: strictish({ name: "Team" }),
			},
		},
	};
	const hit = resolvePolicy({ file, project: { name: "app", cloud_workspace_id: "ws-1" } });
	assert.equal(hit.source, "workspace:acme");
	assert.equal(hit.policy.name, "Team");
	assert.deepEqual(hit.warnings, []);

	const miss = resolvePolicy({ file, project: { name: "app", cloud_workspace_id: "ws-2" } });
	assert.equal(miss.source, "lenient");
	assert.equal(miss.policy.name, "Lenient");
	assert.equal(miss.warnings.length, 1);
	assert.match(miss.warnings[0], /не загружена/);
});

test("resolvePolicy: локальный проект — projects → default → lenient, без слияния", () => {
	const file = {
		schemaVersion: 1,
		default: strictish({ name: "Default" }),
		projects: { app: strictish({ name: "Own" }) },
		workspaces: {},
	};
	assert.equal(
		resolvePolicy({ file, project: { name: "app", cloud_workspace_id: null } }).source,
		"project",
	);
	assert.equal(
		resolvePolicy({ file, project: { name: "other", cloud_workspace_id: null } }).source,
		"default",
	);
	const bare = { schemaVersion: 1, default: null, projects: {}, workspaces: {} };
	const r = resolvePolicy({ file: bare, project: { name: "x", cloud_workspace_id: null } });
	assert.equal(r.source, "lenient");
	assert.equal(r.policy, LENIENT_POLICY);
});

test("pickStartupPolicy: default → единственное пространство → lenient", () => {
	const ws = (name) => ({
		id: name,
		slug: name,
		policyId: "p",
		version: 1,
		body: strictish({ name }),
	});
	assert.equal(
		pickStartupPolicy({
			default: strictish({ name: "D" }),
			projects: {},
			workspaces: { a: ws("a") },
		}).name,
		"D",
	);
	assert.equal(
		pickStartupPolicy({ default: null, projects: {}, workspaces: { a: ws("a") } }).name,
		"a",
	);
	assert.equal(
		pickStartupPolicy({ default: null, projects: {}, workspaces: { a: ws("a"), b: ws("b") } }).name,
		"Lenient",
	);
	assert.equal(pickStartupPolicy({ default: null, projects: {}, workspaces: {} }).name, "Lenient");
});

test("renderToolDescription и renderArtifactTitle", () => {
	assert.equal(renderToolDescription("База.", LENIENT_POLICY, "accept"), "База.");
	const text = renderToolDescription("База.", strictish(), "accept");
	assert.equal(text, "База.\n\nПравила политики «Strictish»:\nOnly after a full run.");
	assert.equal(
		renderToolDescription("База.", strictish(), "delegate"),
		"База.",
		"пустой guidance — только база",
	);
	assert.equal(
		renderArtifactTitle("Project baseline: {project}", "dom-pro"),
		"Project baseline: dom-pro",
	);
});

test("applyWorkspacePolicies: секция заменяется целиком, без политики и невалидные — выпадают", () => {
	const file = {
		schemaVersion: 1,
		default: null,
		projects: {},
		workspaces: { stale: { id: "stale", body: strictish() } },
	};
	const next = applyWorkspacePolicies(
		file,
		[
			{ id: "ws-1", slug: "acme", policyId: "p1", version: 3, body: strictish({ name: "Team" }) },
			{ id: "ws-2", slug: "none" },
			{
				id: "ws-3",
				slug: "bad",
				policyId: "p3",
				version: 1,
				body: strictish({ schemaVersion: 9 }),
			},
		],
		"2026-09-08T00:00:00.000Z",
	);
	assert.deepEqual(Object.keys(next.workspaces), ["ws-1"]);
	assert.equal(next.workspaces["ws-1"].slug, "acme");
	assert.equal(next.workspaces["ws-1"].version, 3);
	assert.equal(next.workspaces["ws-1"].fetchedAt, "2026-09-08T00:00:00.000Z");
	assert.equal(next.workspaces["ws-1"].body.name, "Team");
	assert.equal(file.workspaces.stale.id, "stale", "исходный объект не мутирован");
});

test("readPolicyFile / writePolicyFile: нет файла → пусто, битый JSON → пусто + лог, roundtrip", () => {
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");
	assert.equal(policyConfigPath({ dbPath, env: {} }), join(dir, "policy.json"));
	assert.equal(
		policyConfigPath({ dbPath, env: { ACTARI_POLICY_CONFIG: "/x/p.json" } }),
		"/x/p.json",
	);

	const empty = readPolicyFile({ dbPath, env: {} });
	assert.deepEqual(empty, { schemaVersion: 1, default: null, projects: {}, workspaces: {} });

	writeFileSync(join(dir, "policy.json"), "{not json");
	const logs = [];
	const broken = readPolicyFile({ dbPath, env: {}, log: (m) => logs.push(m) });
	assert.equal(broken.default, null);
	assert.equal(logs.length, 1);

	const file = { ...empty, default: strictish() };
	const path = writePolicyFile({ dbPath, env: {}, file });
	assert.equal(path, join(dir, "policy.json"));
	assert.deepEqual(readPolicyFile({ dbPath, env: {} }), file);
	assert.ok(readFileSync(path, "utf8").endsWith("\n"));
});

test("policyUrlFromBase: базовый адрес → journal-policy, старые суффиксы срезаются", () => {
	assert.equal(
		policyUrlFromBase("https://cloud.example"),
		"https://cloud.example/api/mcp/journal-policy",
	);
	assert.equal(
		policyUrlFromBase("https://cloud.example/api/mcp/journal-sync"),
		"https://cloud.example/api/mcp/journal-policy",
	);
	assert.equal(
		policyUrlFromBase("https://cloud.example/api/mcp/journal-policy/"),
		"https://cloud.example/api/mcp/journal-policy",
	);
});

// ============ get_policy / set_policy ============

test("set_policy/get_policy: default и проект для локального проекта", async (t) => {
	const dbPath = join(tmpDir(), "journal.db");
	const c = startClient(t, { dbPath });
	await reg(c, "app");
	await reg(c, "other");

	let r = await c.tool("get_policy", { project: "app" });
	assert.equal(r.data.source, "lenient");
	assert.equal(r.data.policy.name, "Lenient");

	r = await c.tool("set_policy", { policy: strictish({ name: "Default" }) });
	assert.ok(r.ok, r.error);
	assert.equal(r.data.written, "default");
	assert.equal(r.data.path, join(dirname(dbPath), "policy.json"));

	r = await c.tool("set_policy", { project: "app", policy: strictish({ name: "Own" }) });
	assert.equal(r.data.written, "project:app");

	assert.equal((await c.tool("get_policy", { project: "app" })).data.source, "project");
	assert.equal((await c.tool("get_policy", { project: "app" })).data.policy.name, "Own");
	assert.equal((await c.tool("get_policy", { project: "other" })).data.source, "default");

	const onDisk = JSON.parse(readFileSync(join(dirname(dbPath), "policy.json"), "utf8"));
	assert.equal(onDisk.default.name, "Default");
	assert.equal(onDisk.projects.app.name, "Own");
	assert.equal(onDisk.projects.app.description, "тест");
});

test("set_policy: невалидное тело — список ошибок; облачный проект — отказ", async (t) => {
	const c = startClient(t, { dbPath: join(tmpDir(), "journal.db") });
	await reg(c, "local");
	await reg(c, "cloud", { cloud_workspace_id: "ws-1" });

	let r = await c.tool("set_policy", {
		project: "local",
		policy: strictish({ schemaVersion: 2, name: "" }),
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /schemaVersion/);
	assert.match(r.error, /name/);

	r = await c.tool("set_policy", { project: "cloud", policy: strictish() });
	assert.equal(r.ok, false);
	assert.match(r.error, /привязан к пространству/);
	assert.match(r.error, /ws-1/);

	r = await c.tool("get_policy", { project: "cloud" });
	assert.equal(r.data.source, "lenient");
	assert.equal(r.data.warnings.length, 1);

	r = await c.tool("get_policy", { project: "nope" });
	assert.equal(r.ok, false);
	assert.match(r.error, /не зарегистрирован/);
});

// ============ enforcement ============

test("accept: политика требует evidence — без него отказ с guidance, с ним успех; lenient — свободно", async (t) => {
	const c = startClient(t, { dbPath: join(tmpDir(), "journal.db") });
	await reg(c, "app");
	await c.tool("set_policy", {
		policy: strictish({
			enforce: { accept_requires_evidence: true, draft_requires_artifact: null },
		}),
	});

	let r = await fullCycle(c, "app", "app/t1", { evidence: "" });
	assert.equal(r.ok, false);
	assert.match(r.error, /требует подтверждение/);
	assert.match(r.error, /Only after a full run/);
	assert.equal((await c.tool("get_task", { task_id: "app/t1" })).data.task.status, "REPORTED");

	r = await c.tool("accept", { task_id: "app/t1", evidence: "  abc1234 " });
	assert.ok(r.ok, r.error);
	assert.equal(r.data.evidence, "abc1234");

	await c.tool("set_policy", {
		policy: {
			...strictish(),
			enforce: { accept_requires_evidence: false, draft_requires_artifact: null },
		},
	});
	r = await fullCycle(c, "app", "app/t2", { evidence: "" });
	assert.ok(r.ok, r.error);
	assert.equal(r.data.status, "ACCEPTED");
	assert.equal(r.data.evidence, null);
});

test("draft_task: политика требует артефакт — без него отказ с заголовком, с ним успех", async (t) => {
	const c = startClient(t, { dbPath: join(tmpDir(), "journal.db") });
	await reg(c, "dom-pro");
	await c.tool("set_policy", { policy: strictish() });

	let r = await c.tool("draft_task", {
		project: "dom-pro",
		slug: "one",
		title: "т",
		task_text: "x",
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /Project baseline: dom-pro/);
	assert.match(r.error, /Strictish/);
	assert.match(r.error, /record_artifact/);

	await c.tool("record_artifact", {
		project: "dom-pro",
		kind: "spec",
		title: "Project baseline: dom-pro",
		body: "412/412",
	});
	r = await c.tool("draft_task", { project: "dom-pro", slug: "one", title: "т", task_text: "x" });
	assert.ok(r.ok, r.error);
	assert.equal(r.data.status, "DRAFT");
});

// ============ инструкции и описания ============

test("описания инструментов рендерятся из политики старта (default в policy.json)", async (t) => {
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");
	writeFileSync(
		join(dir, "policy.json"),
		JSON.stringify({ schemaVersion: 1, default: strictish(), projects: {}, workspaces: {} }),
	);
	const c = startClient(t, { dbPath });
	const tools = (await c.call("tools/list")).result.tools;
	const byName = Object.fromEntries(tools.map((x) => [x.name, x.description]));
	assert.match(byName.accept, /Правила политики «Strictish»:\nOnly after a full run\./);
	assert.match(byName.draft_task, /Правила политики «Strictish»:\nD$/);
	assert.match(byName.submit_report, /Правила политики «Strictish»:\nR$/);
	assert.doesNotMatch(byName.delegate, /Правила политики/, "пустой guidance — только база");
	const init = (await c.call("initialize", { protocolVersion: "2024-11-05" })).result;
	assert.match(init.instructions, /сейчас: «Strictish»/);
});

test("без policy.json описания базовые, инструкции — lenient", async (t) => {
	const c = startClient(t, { dbPath: join(tmpDir(), "journal.db") });
	const tools = (await c.call("tools/list")).result.tools;
	for (const tool of tools) assert.doesNotMatch(tool.description, /Правила политики/, tool.name);
	const init = (await c.call("initialize", { protocolVersion: "2024-11-05" })).result;
	assert.match(init.instructions, /сейчас: «Lenient»/);
});

test("предупреждения в инструкциях: облачный проект без кэша; baseline-артефакты без политики", async (t) => {
	const c = startClient(t, { dbPath: join(tmpDir(), "journal.db") });
	await reg(c, "cloud", { cloud_workspace_id: "ws-9" });
	let init = (await c.call("initialize", { protocolVersion: "2024-11-05" })).result;
	assert.match(init.instructions, /политика пространства не загружена.*"cloud"/);

	await reg(c, "legacy");
	await c.tool("record_artifact", {
		project: "legacy",
		kind: "spec",
		title: "Project baseline: legacy",
		body: "x",
	});
	init = (await c.call("initialize", { protocolVersion: "2024-11-05" })).result;
	assert.match(init.instructions, /Project baseline/);
	assert.match(init.instructions, /set_policy/);

	await c.tool("set_policy", { policy: strictish() });
	init = (await c.call("initialize", { protocolVersion: "2024-11-05" })).result;
	assert.doesNotMatch(init.instructions, /похоже, проекты велись/);
});

// ============ pull политики из облака ============

const TOKEN = "test-mcp-token";
const WS = { id: "ws-alpha", slug: "alpha" };

function startMockCloud(t, { policies }) {
	const state = { cursor: 0, policyHits: 0 };
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const send = (code, obj) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(obj));
		};
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "bad token" });
		if (url.pathname.endsWith("/journal-sync")) {
			if (req.method === "GET")
				return send(200, { workspaces: [{ ...WS, name: "Alpha", lastSeq: state.cursor }] });
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const { events } = JSON.parse(body);
				for (const e of events) if (e.seq > state.cursor) state.cursor = e.seq;
				send(200, { applied: events.length, skipped: 0, lastSeq: state.cursor });
			});
			return;
		}
		if (url.pathname.endsWith("/journal-policy")) {
			state.policyHits += 1;
			return send(200, { workspaces: policies() });
		}
		send(404, { error: "Unknown endpoint" });
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			t.after(() => new Promise((r) => server.close(r)));
			resolve({ base: `http://127.0.0.1:${server.address().port}`, state });
		});
	});
}

function cloudEnv(base) {
	return {
		ACTARI_SYNC_URL: `${base}/api/mcp/journal-sync`,
		ACTARI_SYNC_TOKEN: TOKEN,
		ACTARI_SYNC_JOURNAL_ID: "journal-test",
	};
}

test("pull: политика пространства кэшируется при старте и при sync; облачный проект её видит", async (t) => {
	let current = [{ ...WS, policyId: "p1", version: 1, body: strictish({ name: "Team v1" }) }];
	const cloud = await startMockCloud(t, { policies: () => current });
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");
	const c = startClient(t, { dbPath, env: cloudEnv(cloud.base) });
	await reg(c, "app", { cloud_workspace_id: WS.id });

	// Стартовый pull — асинхронный; sync гарантирует свежий кэш
	let r = await c.tool("sync", {});
	assert.match(r.text, /политика пространств: обновлено 1/);
	assert.ok(cloud.state.policyHits >= 1);

	r = await c.tool("get_policy", { project: "app" });
	assert.equal(r.data.source, "workspace:alpha");
	assert.equal(r.data.policy.name, "Team v1");
	const onDisk = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
	assert.equal(onDisk.workspaces[WS.id].policyId, "p1");

	// Новая версия в облаке → следующий sync подтягивает
	current = [{ ...WS, policyId: "p1", version: 2, body: strictish({ name: "Team v2" }) }];
	await c.tool("sync", {});
	assert.equal((await c.tool("get_policy", { project: "app" })).data.policy.name, "Team v2");

	// Пространство сняло политику → кэш очищен, lenient + warning
	current = [{ ...WS }];
	r = await c.tool("sync", {});
	assert.match(r.text, /политика пространств: обновлено 0/);
	r = await c.tool("get_policy", { project: "app" });
	assert.equal(r.data.source, "lenient");
	assert.equal(r.data.warnings.length, 1);
});

test("pull: облако недоступно — sync сообщает ошибку политики, кэш живёт", async (t) => {
	const cloud = await startMockCloud(t, {
		policies: () => [{ ...WS, policyId: "p1", version: 1, body: strictish({ name: "Cached" }) }],
	});
	const dir = tmpDir();
	const dbPath = join(dir, "journal.db");
	let c = startClient(t, { dbPath, env: cloudEnv(cloud.base) });
	await reg(c, "app", { cloud_workspace_id: WS.id });
	await c.tool("sync", {});
	await c.stop();

	// Порт, на котором никто не слушает
	const dead = createServer(() => {});
	await new Promise((r) => dead.listen(0, "127.0.0.1", r));
	const deadBase = `http://127.0.0.1:${dead.address().port}`;
	await new Promise((r) => dead.close(r));

	c = startClient(t, { dbPath, env: cloudEnv(deadBase) });
	const r = await c.tool("sync", {});
	assert.match(r.text, /ошибка синка/);
	assert.match(r.text, /политика пространств: ошибка/);
	assert.equal((await c.tool("get_policy", { project: "app" })).data.policy.name, "Cached");
});

test("pull: без конфига синка — молчаливый no-op", async (t) => {
	const c = startClient(t, { dbPath: join(tmpDir(), "journal.db") });
	const r = await c.tool("sync", {});
	assert.equal(r.text, "синк не настроен (нет sync.json)");
	assert.doesNotMatch(c.getStderr(), /политика/);
});
