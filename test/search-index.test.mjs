// Локальный поисковый индекс журнала (задача search-engine-5): вшитый пакет, DDL и перестройка на месте,
// индексация в транзакциях записи событий, search_precedents. Запуск: node --test test/search-index.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SEARCH_ESM_DIR, VENDOR_DIR, runtimeFiles } from "../scripts/vendor-search.mjs";

// ============ шаг 1: вшитая копия пакета ============

test("vendor/search совпадает со свежей сборкой @actari/search побайтно", () => {
	const hint = "запусти pnpm --filter actari-mcp vendor:search";
	const fresh = runtimeFiles(SEARCH_ESM_DIR);
	assert.ok(
		fresh.length > 0,
		"нет packages/search/dist/esm — собери пакет: pnpm --filter @actari/search build",
	);
	const vendored = runtimeFiles(VENDOR_DIR).filter((f) => f !== "LICENSE-snowball");
	assert.deepEqual(vendored, fresh, `набор файлов vendor/search разошёлся со сборкой — ${hint}`);
	for (const file of fresh) {
		const a = readFileSync(join(SEARCH_ESM_DIR, file));
		const b = readFileSync(join(VENDOR_DIR, file));
		assert.ok(a.equals(b), `${file} отличается от свежей сборки — ${hint}`);
	}
	assert.ok(!fresh.some((f) => f.startsWith("eval")), "в вшитую копию не должен попасть eval/");
});

test("vendor/search отдаёт рантайм пакета без eval", async () => {
	const pkg = await import("../vendor/search/index.js");
	for (const name of [
		"ANALYZER_VERSION",
		"analyze",
		"analyzeQuery",
		"chunkDocument",
		"shouldIndexArtifact",
		"artifactDocKey",
		"journalTaskDocKey",
		"incidentDocKey",
		"collapseByDoc",
		"versionLabel",
		"fuse",
		"DEFAULT_FUSION_WEIGHTS",
		"cosineTopK",
		"passageText",
		"queryText",
		"embeddingKey",
		"snippet",
	]) {
		assert.ok(pkg[name] !== undefined, `экспорт ${name}`);
	}
	// морфология пакета: разные формы слова сходятся к одной основе
	assert.deepEqual(pkg.analyzeQuery("загрузка"), pkg.analyzeQuery("загрузки"));
});

// ============ общие помощники ============

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync as readText, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
	SEARCH_INDEX_VERSION,
	createEmbedder,
	embeddingsConfig,
	ensureSearchIndex,
	fillEmbeddings,
	indexArtifact,
	indexIncident,
	indexTask,
	rankPrecedents,
	searchModeLine,
	searchPrecedents,
} from "../search-index.mjs";

const MCP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_SQL = readText(join(MCP_DIR, "schema.sql"), "utf8");

// FTS-часть схемы до этой задачи: база пользователя, обновляющая пакет, выглядит именно так.
const LEGACY_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(title, task_text, report_text, content = 'tasks', content_rowid = 'rowid');
CREATE TRIGGER IF NOT EXISTS tasks_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO task_fts(rowid, title, task_text, report_text) VALUES (NEW.rowid, NEW.title, NEW.task_text, NEW.report_text);
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, task_text, report_text) VALUES ('delete', OLD.rowid, OLD.title, OLD.task_text, OLD.report_text);
  INSERT INTO task_fts(rowid, title, task_text, report_text) VALUES (NEW.rowid, NEW.title, NEW.task_text, NEW.report_text);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(title, body, content = 'artifacts', content_rowid = 'id');
CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifact_fts(rowid, title, body) VALUES (NEW.id, NEW.title, NEW.body);
END;
`;

function tmpDb({ legacy = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "actari-search-"));
	const path = join(dir, "journal.db");
	const db = new DatabaseSync(path);
	db.exec(SCHEMA_SQL);
	if (legacy) db.exec(LEGACY_FTS);
	return { db, path, dir };
}

function addEvent(db, taskId, type, payload) {
	db.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)").run(
		taskId,
		type,
		JSON.stringify(payload),
	);
}

function registerProject(db, name, root = `/tmp/${name}`) {
	addEvent(db, "_general", "ProjectRegistered", { name, root_path: root });
}

/** Прямые строки проекций (индекс строим вручную): задача, артефакт, инцидент. */
function putTask(db, row) {
	db.prepare(
		`INSERT OR REPLACE INTO tasks(task_id, project, title, task_text, report_text, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.task_id,
		row.project,
		row.title,
		row.task_text ?? "",
		row.report_text ?? null,
		row.status ?? "ACCEPTED",
		row.at ?? "2026-10-01 10:00:00",
		row.at ?? "2026-10-01 10:00:00",
	);
	const stored = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(row.task_id);
	indexTask(db, stored);
	return stored;
}

function putArtifact(db, row) {
	const res = db
		.prepare(
			"INSERT INTO artifacts(task_id, project, kind, title, body, at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			row.task_id ?? null,
			row.project,
			row.kind ?? "doc",
			row.title,
			row.body,
			row.at ?? "2026-10-01 10:00:00",
		);
	const stored = db
		.prepare("SELECT * FROM artifacts WHERE id = ?")
		.get(Number(res.lastInsertRowid));
	indexArtifact(db, stored);
	return stored;
}

function putIncident(db, row) {
	const res = db
		.prepare("INSERT INTO incidents(task_id, description, lesson, at) VALUES (?, ?, ?, ?)")
		.run(
			row.task_id ?? "_general",
			row.description,
			row.lesson ?? "",
			row.at ?? "2026-10-01 10:00:00",
		);
	const stored = db
		.prepare("SELECT * FROM incidents WHERE id = ?")
		.get(Number(res.lastInsertRowid));
	indexIncident(db, { ...stored, project: row.project });
	return stored;
}

const counts = (db) =>
	Object.fromEntries(
		["events", "tasks", "artifacts", "incidents"].map((t) => [
			t,
			db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n,
		]),
	);

// ============ шаг 2: ensureSearchIndex ============

test("ensureSearchIndex: новая база — таблицы созданы, версия индекса записана, тишина в логе", () => {
	const { db } = tmpDb();
	const lines = [];
	const res = ensureSearchIndex(db, { log: (l) => lines.push(l) });
	assert.equal(res.rebuilt, true);
	assert.deepEqual(lines, [], "на пустой новой базе лог молчит");
	const names = db
		.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'search_%'")
		.all()
		.map((r) => r.name);
	for (const n of ["search_chunks", "search_fts", "search_vectors", "search_meta"]) {
		assert.ok(names.includes(n), `таблица ${n}`);
	}
	assert.equal(
		db.prepare("SELECT value FROM search_meta WHERE key = 'index_version'").get().value,
		SEARCH_INDEX_VERSION,
	);
	assert.equal(
		ensureSearchIndex(db, { log: () => {} }).rebuilt,
		false,
		"второй запуск — без перестройки",
	);
});

test("ensureSearchIndex: база со старыми task_fts/artifact_fts — перестройка на месте, inode и данные целы", () => {
	const { db, path } = tmpDb({ legacy: true });
	registerProject(db, "demo");
	addEvent(db, "demo/t1", "TaskDrafted", {
		project: "demo",
		title: "Загрузка фото",
		task_text: "переделать загрузку фото на слабом интернете",
	});
	addEvent(db, "demo/t1", "Delegated", { executor: "x" });
	addEvent(db, "demo/t1", "ReportSubmitted", { report: "сделали повторную отправку файлов" });
	addEvent(db, "demo/t1", "ArtifactRecorded", {
		project: "demo",
		kind: "spec",
		title: "Спека загрузки",
		body: "## Решение\nочередь отправки с повторами",
	});
	addEvent(db, "demo/t1", "IncidentRecorded", {
		description: "обрыв соединения",
		lesson: "повторять",
	});
	assert.ok(
		db.prepare("SELECT 1 FROM task_fts WHERE task_fts MATCH 'загрузку'").get(),
		"старый FTS работал до миграции",
	);

	const before = { ino: statSync(path).ino, rows: counts(db) };
	const lines = [];
	const res = ensureSearchIndex(db, { log: (l) => lines.push(l) });
	assert.equal(res.rebuilt, true);
	assert.equal(statSync(path).ino, before.ino, "файл базы тот же (inode не изменился)");
	assert.deepEqual(counts(db), before.rows, "счётчики events/tasks/artifacts/incidents до = после");

	const left = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE name IN ('task_fts','artifact_fts','tasks_fts_insert','tasks_fts_update','artifacts_fts_insert')",
		)
		.all();
	assert.deepEqual(left, [], "старые FTS и триггеры удалены");
	assert.equal(lines.length, 1);
	assert.match(lines[0], /индекс поиска перестроен на месте/);
	assert.match(lines[0], /задач 1, артефактов 1, инцидентов 1/);
	// после миграции записи по-прежнему идут (триггеры tasks не ссылаются на удалённые таблицы)
	addEvent(db, "demo/t2", "TaskDrafted", { project: "demo", title: "Ещё", task_text: "текст" });
	assert.equal(counts(db).tasks, 2);
});

test("ensureSearchIndex: смена версии индекса — перестройка на месте, лог в stderr, чанки те же", () => {
	const { db, path } = tmpDb();
	registerProject(db, "demo");
	addEvent(db, "demo/t1", "TaskDrafted", {
		project: "demo",
		title: "Заголовок",
		task_text: "текст",
	});
	ensureSearchIndex(db, { log: () => {} });
	const chunksBefore = db.prepare("SELECT count(*) AS n FROM search_chunks").get().n;
	assert.ok(chunksBefore > 0);
	db.prepare("UPDATE search_meta SET value = '0.0' WHERE key = 'index_version'").run();
	const ino = statSync(path).ino;
	const lines = [];
	assert.equal(ensureSearchIndex(db, { log: (l) => lines.push(l) }).rebuilt, true);
	assert.equal(statSync(path).ino, ino);
	assert.equal(db.prepare("SELECT count(*) AS n FROM search_chunks").get().n, chunksBefore);
	assert.match(lines[0], new RegExp(`0\\.0 → ${SEARCH_INDEX_VERSION.replace(".", "\\.")}`));
});

// ============ шаг 3: индексация в транзакциях записи событий ============

function startServer(t, { env = {}, dbPath, cwd } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "actari-search-srv-"));
	const db = dbPath ?? join(dir, "journal.db");
	const child = spawn(process.execPath, [join(MCP_DIR, "server.mjs")], {
		cwd,
		env: { ...process.env, ACTARI_DB: db, ACTARI_SEARCH_EMBEDDINGS: "", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	t.after(() => child.kill());
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c) => (stderr += c));
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
		if (msg.result.isError) return { ok: false, error: text };
		try {
			return { ok: true, data: JSON.parse(text), text };
		} catch {
			return { ok: true, text };
		}
	};
	return { call, tool, dbPath: db, stderr: () => stderr, child };
}

async function initServer(c) {
	await c.call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "t", version: "0" },
	});
}

test("индексация в транзакциях записи: draft_task, submit_report, record_artifact, record_incident находятся с морфологией", async (t) => {
	const c = startServer(t);
	await initServer(c);
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo-search" });
	const drafted = await c.tool("draft_task", {
		project: "demo",
		slug: "ranks",
		title: "Ранги расписания",
		task_text: "перенормировать ранги ганта в расписании",
	});
	const taskId = drafted.data.task_id;

	let r = await c.tool("search_precedents", { query: "ранг расписание" });
	assert.deepEqual(
		r.data.tasks.map((x) => x.task_id),
		[taskId],
		"задание находится сразу после draft_task: «ранг» ↔ «ранги», «расписание» ↔ «расписании»",
	);

	await c.tool("delegate", { task_id: taskId, executor: "x" });
	await c.tool("submit_report", {
		task_id: taskId,
		report: "исправили гонку при параллельной сборке",
	});
	r = await c.tool("search_precedents", { query: "параллельная сборка гонки" });
	assert.ok(
		r.data.tasks.some((x) => x.task_id === taskId),
		"отчёт находится сразу после submit_report",
	);
	assert.match(r.data.tasks[0].report_snippet, /\[/, "в сниппете отчёта подсвечено совпадение");

	await c.tool("record_artifact", {
		project: "demo",
		kind: "spec",
		title: "Спека кэша",
		body: "## Решение\nинвалидация кэша происходит по версиям схемы",
		task_id: taskId,
	});
	r = await c.tool("search_precedents", { query: "инвалидировать кэши версии" });
	assert.equal(r.data.artifacts.length, 1, "артефакт находится сразу после record_artifact");
	assert.equal(r.data.artifacts[0].title, "Спека кэша");

	await c.tool("record_incident", {
		task_id: taskId,
		description: "обрыв соединения при загрузке больших файлов",
		lesson: "повторять отправку частями",
	});
	r = await c.tool("search_precedents", { query: "оборвалось соединение, повторная отправка" });
	assert.equal(r.data.incidents.length, 1, "инцидент находится сразу после record_incident");
});

test("событие, записанное мимо индекса (старая версия сервера), находится: перед поиском индекс догоняет", async (t) => {
	const c = startServer(t);
	await initServer(c);
	await c.tool("register_project", { name: "demo", root_path: "/tmp/demo-old" });
	await c.tool("draft_task", {
		project: "demo",
		slug: "a",
		title: "Первая",
		task_text: "обычный текст",
	});

	// «старая версия сервера» пишет событие напрямую: триггеры проекций сработают, индекс — нет
	const raw = new DatabaseSync(c.dbPath);
	raw.exec("PRAGMA busy_timeout = 5000");
	raw.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, 'TaskDrafted', ?)").run(
		"demo/legacy-writer",
		JSON.stringify({
			project: "demo",
			title: "Мимо индекса",
			task_text: "уникальнословопроверки",
		}),
	);
	raw.close();

	const r = await c.tool("search_precedents", { query: "уникальнословопроверки" });
	assert.deepEqual(
		r.data.tasks.map((x) => x.task_id),
		["demo/legacy-writer"],
		"перед поиском индекс догоняет события, записанные мимо него",
	);
});

test("запуск сервера на базе со старым FTS перестраивает индекс на месте, inode и данные целы", async (t) => {
	const { db, path } = tmpDb({ legacy: true });
	registerProject(db, "demo", "/tmp/demo-legacy");
	addEvent(db, "demo/t1", "TaskDrafted", {
		project: "demo",
		title: "Старая задача",
		task_text: "текст про оптимизацию запросов",
	});
	const before = { ino: statSync(path).ino, rows: counts(db) };
	db.close();

	const c = startServer(t, { dbPath: path });
	await initServer(c);
	const r = await c.tool("search_precedents", { query: "оптимизация запроса" });
	assert.deepEqual(
		r.data.tasks.map((x) => x.task_id),
		["demo/t1"],
	);
	assert.match(c.stderr(), /индекс поиска перестроен на месте/);
	const after = new DatabaseSync(path, { readOnly: true });
	assert.equal(statSync(path).ino, before.ino);
	assert.deepEqual(counts(after), before.rows);
	assert.equal(
		after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%.bak'").get().n,
		0,
	);
	after.close();
});

// ============ шаг 4: searchPrecedents ============

function readyDb() {
	const t = tmpDb();
	ensureSearchIndex(t.db, { log: () => {} });
	return t.db;
}

test("searchPrecedents: ищет по всем проектам, проект текущего каталога выше при равном совпадении", async () => {
	const db = readyDb();
	for (const project of ["alpha", "beta"]) {
		putTask(db, {
			task_id: `${project}/t`,
			project,
			title: "Кэш",
			task_text: "инвалидация кэша по версиям",
		});
	}
	const all = await searchPrecedents(db, { query: "инвалидировать кэши" });
	assert.equal(all.tasks.length, 2, "оба проекта в выдаче");
	const alphaFirst = await searchPrecedents(db, {
		query: "инвалидировать кэши",
		currentProject: "alpha",
	});
	assert.equal(alphaFirst.tasks[0].task_id, "alpha/t");
	const betaFirst = await searchPrecedents(db, {
		query: "инвалидировать кэши",
		currentProject: "beta",
	});
	assert.equal(betaFirst.tasks[0].task_id, "beta/t");
});

test("searchPrecedents: множитель текущего проекта 1.5 — чужое заметно лучшее совпадение остаётся выше", async () => {
	const db = readyDb();
	putTask(db, {
		task_id: "alpha/t",
		project: "alpha",
		title: "Разное",
		task_text: "кэш и ещё много других слов подряд про другое",
	});
	putTask(db, {
		task_id: "beta/t",
		project: "beta",
		title: "Кэш кэш",
		task_text: "кэш кэш инвалидация кэша",
	});
	const r = await searchPrecedents(db, { query: "кэш инвалидация", currentProject: "alpha" });
	assert.equal(r.tasks[0].task_id, "beta/t", "буст — множитель, а не фильтр");
});

test("searchPrecedents: project — жёсткий фильтр для задач, артефактов и инцидентов", async () => {
	const db = readyDb();
	registerProject(db, "alpha");
	for (const project of ["alpha", "beta"]) {
		putTask(db, { task_id: `${project}/t`, project, title: "Кэш", task_text: "инвалидация кэша" });
		putArtifact(db, {
			project,
			kind: "doc",
			title: `Док ${project}`,
			body: "про кэш и инвалидацию",
		});
		putIncident(db, {
			task_id: `${project}/t`,
			project,
			description: "кэш протух",
			lesson: "инвалидировать",
		});
	}
	putIncident(db, {
		task_id: "_general",
		description: "общий кэш протух",
		lesson: "инвалидировать",
	});
	const r = await searchPrecedents(db, { query: "инвалидация кэша", project: "alpha" });
	assert.deepEqual(
		r.tasks.map((x) => x.project),
		["alpha"],
	);
	assert.deepEqual(
		r.artifacts.map((x) => x.project),
		["alpha"],
	);
	assert.equal(r.incidents.length, 1, "инцидент без проекта при фильтре не возвращается");
	const noFilter = await searchPrecedents(db, { query: "инвалидация кэша" });
	assert.equal(noFilter.incidents.length, 3);
});

test("searchPrecedents: две версии артефакта — одна запись, свежайшая подходящая; только в первой — она, с version_label", async () => {
	const db = readyDb();
	const v1 = putArtifact(db, {
		project: "demo",
		kind: "spec",
		title: "Project baseline: demo",
		body: "Стек: React и Vite, менеджер пакетов pnpm.",
		at: "2026-08-01 10:00:00",
	});
	const v2 = putArtifact(db, {
		project: "demo",
		kind: "spec",
		title: "Project baseline: demo",
		body: "Всё, что не сказано ниже, в силе. Тесты: node --test.",
		at: "2026-09-15 10:00:00",
	});
	const v3 = putArtifact(db, {
		project: "demo",
		kind: "spec",
		title: "Project baseline: demo",
		body: "Тесты: node --test, покрытие считаем отдельно.",
		at: "2026-10-20 10:00:00",
	});

	let r = await searchPrecedents(db, { query: "тесты" });
	assert.equal(r.artifacts.length, 1, "одна запись на документ");
	assert.equal(r.artifacts[0].id, v3.id, "свежайшая подходящая версия");
	assert.equal(r.artifacts[0].version_label, undefined, "последняя версия без пометки");

	r = await searchPrecedents(db, { query: "стек React pnpm" });
	assert.equal(r.artifacts.length, 1);
	assert.equal(r.artifacts[0].id, v1.id, "совпадение только в первой версии — она");
	assert.equal(r.artifacts[0].version_label, "версия от 2026-08-01");
	assert.ok(v2.id > v1.id);
});

test("searchPrecedents: служебные заметки не находятся, Project baseline находится", async () => {
	const db = readyDb();
	for (const title of [
		"acceptance: demo/t1",
		"release: фича",
		"released: фича",
		"brief: фича",
		"progress: фича",
	]) {
		putArtifact(db, { project: "demo", kind: "note", title, body: "уникальноеслововслужебной" });
	}
	putArtifact(db, {
		project: "demo",
		kind: "spec",
		title: "Project baseline: demo",
		body: "уникальноеслововслужебной",
	});
	putArtifact(db, {
		project: "demo",
		kind: "note",
		title: "Обычная заметка",
		body: "уникальноеслововслужебной",
	});
	const r = await searchPrecedents(db, { query: "уникальноеслововслужебной", limit: 10 });
	assert.deepEqual(
		r.artifacts.map((a) => a.title).sort(),
		["Project baseline: demo", "Обычная заметка"].sort(),
	);
});

test("searchPrecedents: формат ответа совместим с прежним", async () => {
	const db = readyDb();
	putTask(db, {
		task_id: "demo/t",
		project: "demo",
		title: "Заголовок",
		task_text: "текст про облако",
		report_text: "отчёт про облако",
		status: "ACCEPTED",
	});
	db.prepare("UPDATE tasks SET outcome='accepted', evidence='abc' WHERE task_id='demo/t'").run();
	putArtifact(db, {
		project: "demo",
		kind: "doc",
		title: "Док",
		body: "маппинг на облако",
		task_id: "demo/t",
	});
	putIncident(db, {
		task_id: "demo/t",
		project: "demo",
		description: `${"d".repeat(500)} облако`,
		lesson: "l".repeat(400),
	});
	const r = await searchPrecedents(db, { query: "облако" });
	assert.deepEqual(Object.keys(r), ["tasks", "artifacts", "incidents"]);
	assert.deepEqual(Object.keys(r.tasks[0]), [
		"task_id",
		"project",
		"title",
		"status",
		"outcome",
		"evidence",
		"task_snippet",
		"report_snippet",
	]);
	assert.equal(r.tasks[0].outcome, "accepted");
	assert.deepEqual(Object.keys(r.artifacts[0]), [
		"id",
		"project",
		"kind",
		"title",
		"task_id",
		"at",
		"body_snippet",
	]);
	assert.ok(r.artifacts[0].body_snippet.includes("[облако]"));
	assert.deepEqual(Object.keys(r.incidents[0]), [
		"id",
		"task_id",
		"at",
		"description",
		"lesson",
		"description_length",
		"lesson_length",
	]);
	assert.ok(r.incidents[0].description.length <= 281);
	assert.equal(r.incidents[0].description_length, 507);
	const full = await searchPrecedents(db, { query: "облако", full: true });
	assert.equal(full.incidents[0].description.length, 507);
	assert.ok(!("description_length" in full.incidents[0]));
});

test("searchPrecedents: пустой и состоящий из стоп-слов запрос — пустая выдача без ошибок; limit ограничивает задачи", async () => {
	const db = readyDb();
	for (let i = 0; i < 4; i++) {
		putTask(db, {
			task_id: `demo/t${i}`,
			project: "demo",
			title: `Задача ${i}`,
			task_text: "общий текст про синхронизацию",
		});
	}
	assert.deepEqual(await searchPrecedents(db, { query: "   " }), {
		tasks: [],
		artifacts: [],
		incidents: [],
	});
	assert.deepEqual(await searchPrecedents(db, { query: "и в на" }), {
		tasks: [],
		artifacts: [],
		incidents: [],
	});
	const r = await searchPrecedents(db, { query: "синхронизация", limit: 2 });
	assert.equal(r.tasks.length, 2);
});

test("переиндексация задачи: старые термы не находятся, новые находятся (contentless FTS удаляет точно)", async () => {
	const db = readyDb();
	putTask(db, { task_id: "demo/t", project: "demo", title: "Заголовок", task_text: "старыйтерм" });
	assert.equal((await searchPrecedents(db, { query: "старыйтерм" })).tasks.length, 1);
	db.prepare("UPDATE tasks SET task_text = 'новыйтерм' WHERE task_id = 'demo/t'").run();
	indexTask(db, db.prepare("SELECT * FROM tasks WHERE task_id = 'demo/t'").get());
	assert.equal((await searchPrecedents(db, { query: "старыйтерм" })).tasks.length, 0);
	assert.equal((await searchPrecedents(db, { query: "новыйтерм" })).tasks.length, 1);
	assert.equal(db.prepare("SELECT count(*) AS n FROM search_chunks").get().n, 1);
});

// ============ шаг 5: векторы по явному включению ============

const E5 = "intfloat/multilingual-e5-large";

/** Тематический вектор: «фото» и «снимок» — одна ось, «склад» — другая. Сеть не трогается. */
function topicVec(text) {
	const t = text.toLowerCase();
	if (/фото|снимок|картинк/.test(t)) return [1, 0, 0];
	if (/склад/.test(t)) return [0, 1, 0];
	return [0, 0, 1];
}

function fakeFetch({ limit413 = Infinity, fail = false } = {}) {
	const calls = [];
	const impl = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({
			url: String(url),
			headers: init.headers,
			size: body.input.length,
			input: body.input,
		});
		if (fail) return { ok: false, status: 500, json: async () => ({}) };
		if (body.input.length > limit413) return { ok: false, status: 413, json: async () => ({}) };
		return {
			ok: true,
			status: 200,
			json: async () => ({
				data: body.input.map((text, index) => ({ index, embedding: topicVec(text) })),
			}),
		};
	};
	return { impl, calls };
}

const ON = {
	ACTARI_SEARCH_EMBEDDINGS: "on",
	OPENAI_EMBEDDING_BASE_URL: "https://emb.example.com/v1",
	OPENAI_EMBEDDING_MODEL: E5,
	OPENAI_EMBEDDING_API_KEY: "k-test",
	OPENAI_EMBEDDING_API_KEY_HEADER: "X-API-Key",
};

test("embeddingsConfig: одних OPENAI_EMBEDDING_* мало, нужен ACTARI_SEARCH_EMBEDDINGS=on", () => {
	const { ACTARI_SEARCH_EMBEDDINGS, ...varsOnly } = ON;
	const off = embeddingsConfig(varsOnly);
	assert.equal(off.enabled, false);
	assert.match(off.reason, /ACTARI_SEARCH_EMBEDDINGS=on/);
	assert.equal(searchModeLine(off), "поиск: слова");

	const noVars = embeddingsConfig({ ACTARI_SEARCH_EMBEDDINGS: "on" });
	assert.equal(noVars.enabled, false);
	assert.match(noVars.reason, /OPENAI_EMBEDDING_BASE_URL/);

	const on = embeddingsConfig(ON);
	assert.equal(on.enabled, true);
	assert.equal(searchModeLine(on), `поиск: слова + векторы (emb.example.com, ${E5})`);
	assert.equal(embeddingsConfig({}).enabled, false);
});

test("без ACTARI_SEARCH_EMBEDDINGS=on сеть не трогается, даже при заданных OPENAI_EMBEDDING_*", async (t) => {
	const { ACTARI_SEARCH_EMBEDDINGS, ...varsOnly } = ON;
	const stub = fakeFetch();
	const realFetch = globalThis.fetch;
	globalThis.fetch = stub.impl;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const embedder = createEmbedder(embeddingsConfig(varsOnly));
	assert.equal(embedder, null);
	const db = readyDb();
	putTask(db, { task_id: "demo/t", project: "demo", title: "Фото", task_text: "загрузка фото" });
	const r = await searchPrecedents(db, { query: "фото", embeddings: embedder });
	assert.equal(r.tasks.length, 1);
	assert.equal(stub.calls.length, 0, "ноль вызовов fetch");
});

test("с включением: заголовки авторизации, префиксы e5, досчёт до 64 за вызов пачками по 16, деление при 413", async () => {
	const db = readyDb();
	for (let i = 0; i < 80; i++) {
		putTask(db, {
			task_id: `demo/t${i}`,
			project: "demo",
			title: `Задача ${i}`,
			task_text: `текст ${i} про склад`,
		});
	}
	const stub = fakeFetch({ limit413: 8 });
	const embedder = createEmbedder(embeddingsConfig(ON), { fetchImpl: stub.impl });
	const done = await fillEmbeddings(db, embedder);
	assert.equal(done, 64, "до 64 фрагментов за вызов");
	assert.equal(db.prepare("SELECT count(*) AS n FROM search_vectors").get().n, 64);
	assert.ok(
		stub.calls.every((c) => c.size <= 16),
		"пачки не больше 16",
	);
	assert.ok(
		stub.calls.some((c) => c.size === 8),
		"отвергнутая 413 пачка поделена пополам",
	);
	assert.ok(
		stub.calls.some((c) => c.size === 16),
		"первая попытка — пачка из 16",
	);
	assert.equal(stub.calls[0].url, "https://emb.example.com/v1/embeddings");
	assert.equal(stub.calls[0].headers["X-API-Key"], "k-test");
	assert.equal(stub.calls[0].headers.authorization, undefined);
	assert.ok(stub.calls[0].input[0].startsWith("passage: "), "префикс e5 для фрагментов");
	const second = await fillEmbeddings(db, embedder);
	assert.equal(second, 16, "остальное — следующим вызовом");
});

test("с включением: документ, найденный только по смыслу, попадает в выдачу; префикс query: у вопроса", async () => {
	const db = readyDb();
	putTask(db, {
		task_id: "demo/photo",
		project: "demo",
		title: "Снимки",
		task_text: "сжатие снимков перед отправкой",
	});
	putTask(db, {
		task_id: "demo/store",
		project: "demo",
		title: "Склад",
		task_text: "остатки на складе",
	});
	const stub = fakeFetch();
	const embedder = createEmbedder(embeddingsConfig(ON), { fetchImpl: stub.impl });
	const words = await searchPrecedents(db, { query: "фото" });
	assert.deepEqual(words.tasks, [], "по словам «фото» ничего не находит");
	const r = await searchPrecedents(db, { query: "фото", embeddings: embedder });
	assert.equal(r.tasks[0].task_id, "demo/photo", "вектор находит по смыслу");
	assert.ok(stub.calls.some((c) => c.input.includes("query: фото")));
});

test("ошибка сервиса эмбеддингов — ответ по словам, без исключения", async () => {
	const db = readyDb();
	putTask(db, { task_id: "demo/t", project: "demo", title: "Кэш", task_text: "инвалидация кэша" });
	const stub = fakeFetch({ fail: true });
	const embedder = createEmbedder(embeddingsConfig(ON), { fetchImpl: stub.impl });
	const lines = [];
	const r = await searchPrecedents(db, {
		query: "инвалидировать кэш",
		embeddings: embedder,
		log: (l) => lines.push(l),
	});
	assert.deepEqual(
		r.tasks.map((x) => x.task_id),
		["demo/t"],
	);
	assert.match(lines[0], /векторы поиска недоступны/);
});

test("сервер: без включения запросов в сервис эмбеддингов нет; с включением — есть; connect показывает режим", async (t) => {
	const hits = [];
	const srv = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const input = JSON.parse(body || "{}").input ?? [];
			hits.push(input.length);
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({ data: input.map((x, index) => ({ index, embedding: topicVec(x) })) }),
			);
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const base = `http://127.0.0.1:${srv.address().port}/v1`;
	const vars = { OPENAI_EMBEDDING_BASE_URL: base, OPENAI_EMBEDDING_MODEL: E5 };

	const off = startServer(t, { env: vars });
	await initServer(off);
	await off.tool("register_project", { name: "demo", root_path: "/tmp/demo-emb" });
	await off.tool("draft_task", {
		project: "demo",
		slug: "a",
		title: "Снимки",
		task_text: "сжатие снимков",
	});
	const r0 = await off.tool("search_precedents", { query: "снимки" });
	assert.equal(r0.data.tasks.length, 1);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(hits.length, 0, "флаг не включён — сеть не тронута");

	const on = startServer(t, { env: { ...vars, ACTARI_SEARCH_EMBEDDINGS: "on" } });
	await initServer(on);
	await on.tool("register_project", { name: "demo", root_path: "/tmp/demo-emb" });
	await on.tool("draft_task", {
		project: "demo",
		slug: "a",
		title: "Снимки",
		task_text: "сжатие снимков",
	});
	const r1 = await on.tool("search_precedents", { query: "фото" });
	assert.equal(r1.data.tasks.length, 1, "вектор нашёл по смыслу то, чего нет в словах");
	assert.ok(hits.length > 0, "флаг включён — сервис вызван");
});

test("пул кандидатов: длинный документ (250+ фрагментов) не вытесняет остальные документы из выдачи по словам", async () => {
	const db = readyDb();
	const filler = "общие положения порядок применения требования к участникам и объектам ".repeat(
		11,
	);
	const heavy = Array.from(
		{ length: 260 },
		(_, i) => `Раздел ${i}. стандарт стандарт стандарт стандарт стандарт стандарт ${filler}`,
	).join("\n\n");
	putArtifact(db, { project: "alpha", kind: "doc", title: "Стандарт — длинный том", body: heavy });
	for (let i = 1; i <= 4; i++) {
		putArtifact(db, {
			project: "alpha",
			kind: "doc",
			title: `Стандарт — краткий раздел ${i}`,
			body: `Раздел ${i}. Здесь один раз упомянут стандарт. ${filler}`,
		});
	}
	const { hits } = await rankPrecedents(db, { query: "стандарт" });
	const titles = hits.map((h) => h.title);
	assert.ok(titles.includes("Стандарт — длинный том"));
	for (let i = 1; i <= 4; i++) {
		assert.ok(
			titles.includes(`Стандарт — краткий раздел ${i}`),
			`раздел ${i} вытеснен: в выдаче ${titles.length} документов`,
		);
	}
});

test("searchPrecedents: локальные пути («Источник: /Users/…») не попадают в сниппеты артефактов, задач и инцидентов", async () => {
	const db = readyDb();
	putArtifact(db, {
		project: "alpha",
		kind: "doc",
		title: "Стандарт — раздел",
		body: "Источник: /Users/kvandake/Downloads/DomPro/IZhS-Standart-R1.md\n\nТребования стандарта к участникам.",
	});
	putTask(db, {
		task_id: "alpha/t1",
		project: "alpha",
		title: "Стандарт",
		task_text: "Читать /Users/kvandake/projects/alpha/notes.md про стандарт",
		report_text: "Готово, см. /home/ivan/out/report.txt по стандарту",
	});
	const res = await searchPrecedents(db, { query: "стандарт" });
	const text = JSON.stringify(res);
	assert.ok(!/\/(Users|home)\//.test(text), text);
	assert.match(JSON.stringify(res.artifacts), /Источник: ~\/IZhS-Standart-R1\.md/);
});
