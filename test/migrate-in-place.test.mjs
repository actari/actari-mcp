// Обновление схемы журнала на месте (public-launch-readiness T7): два настоящих процесса,
// файл базы не подменяется (инциденты 93, 152). Запуск: node --test test/migrate-in-place.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");
const SCHEMA = join(ROOT, "schema.sql");
const OLD_WRITER = join(ROOT, "test", "support", "old-writer.mjs");
const REFUSAL = "журнал обновлён другим процессом — перезапустите сессию";

function cleanEnv(extra = {}) {
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("ACTARI_")) delete env[k];
	return { ...env, ACTARI_SCHEMA: SCHEMA, ...extra };
}

function startServer(t, dbPath) {
	const child = spawn(process.execPath, [SERVER], {
		env: cleanEnv({ ACTARI_DB: dbPath }),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c) => (stderr += c));
	const exited = new Promise((r) => child.on("exit", (code) => r(code)));
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
	const tool = async (name, args) => {
		const msg = await new Promise((resolve) => {
			const id = ++seq;
			pending.set(id, resolve);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
			);
		});
		const text = msg.result.content[0].text;
		if (msg.result.isError) return { ok: false, error: text };
		try {
			return { ok: true, data: JSON.parse(text), text };
		} catch {
			return { ok: true, text };
		}
	};
	return {
		tool,
		exited,
		getStderr: () => stderr,
		stop: async () => {
			child.kill();
			await exited;
		},
	};
}

function startOldWriter(t, dbPath) {
	const child = spawn(process.execPath, [OLD_WRITER, dbPath], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	t.after(() => child.kill());
	const lines = [];
	const waiters = [];
	createInterface({ input: child.stdout }).on("line", (l) => {
		const w = waiters.shift();
		if (w) w(l);
		else lines.push(l);
	});
	const next = () =>
		lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r));
	return {
		ready: next,
		write: async (taskId) => {
			child.stdin.write(`write ${taskId}\n`);
			return next();
		},
		quit: () => {
			child.stdin.write("quit\n");
		},
	};
}

// База старой схемы: CHECK без UsageRecorded и Released (версия пакета до обновления).
function legacySchemaSql() {
	return readFileSync(SCHEMA, "utf8")
		.split("\n")
		.filter((l) => !/^\s*'UsageRecorded',/.test(l) && !/^\s*'Released'\s+--/.test(l))
		.join("\n")
		.replace("'ProjectRegistered',", "'ProjectRegistered'");
}

function makeLegacyDb(dir, { extra } = {}) {
	const dbPath = join(dir, "journal.db");
	const db = new DatabaseSync(dbPath);
	const ddl = legacySchemaSql();
	const eventsDdl = ddl.slice(
		ddl.indexOf("CREATE TABLE IF NOT EXISTS events"),
		ddl.indexOf("CREATE INDEX"),
	);
	assert.ok(!eventsDdl.includes("UsageRecorded"), "старый CHECK без UsageRecorded");
	db.exec(ddl);
	const ins = db.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)");
	ins.run("_general", "ProjectRegistered", JSON.stringify({ name: "old", root_path: "/tmp/old" }));
	ins.run("old/t1", "TaskDrafted", JSON.stringify({ project: "old", title: "т1", task_text: "x" }));
	ins.run("old/t1", "Delegated", JSON.stringify({ executor: "grok" }));
	extra?.(db, ins);
	return { dbPath, db };
}

const counts = (path) => {
	const d = new DatabaseSync(path, { readOnly: true });
	try {
		return {
			events: d.prepare("SELECT count(*) n FROM events").get().n,
			tasks: d.prepare("SELECT count(*) n FROM tasks").get().n,
		};
	} finally {
		d.close();
	}
};
const dbFiles = (dir) => readdirSync(dir).filter((f) => !f.endsWith(".bak"));
const baks = (dir) => readdirSync(dir).filter((f) => f.endsWith(".bak"));

test("A держит старую схему, B обновляет на месте, A пишет: запись в той же базе, inode тот же", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "actari-inplace-"));
	const { dbPath, db } = makeLegacyDb(dir);
	db.close();
	const inoBefore = statSync(dbPath).ino;

	const a = startOldWriter(t, dbPath);
	assert.match(await a.ready(), /^ready /);

	const b = startServer(t, dbPath);
	const list = await b.tool("list_tasks", { project: "old" });
	assert.ok(list.ok, list.error);
	assert.match(b.getStderr(), /перенесено \d+ событий/);

	assert.equal(statSync(dbPath).ino, inoBefore, "inode файла базы не изменился");
	assert.equal(baks(dir).length, 1, "бэкап создан");
	assert.deepEqual(
		dbFiles(dir).filter((f) => !f.startsWith("journal.db")),
		[],
		"других файлов базы нет",
	);

	assert.equal(await a.write("old/from-a"), "ok", "старый процесс пишет без ошибки");
	const seen = await b.tool("get_task", { task_id: "old/from-a" });
	assert.ok(seen.ok, "запись старого процесса видна в обновлённой базе");
	assert.equal(statSync(dbPath).ino, inoBefore);

	a.quit();
	await b.stop();
	const after = new DatabaseSync(dbPath, { readOnly: true });
	assert.match(
		after.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get().sql,
		/UsageRecorded/,
		"CHECK обновлён",
	);
	after.close();
});

test("файл базы подменён под живым процессом: отказ с точным текстом, записи нет", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "actari-inplace-"));
	const dbPath = join(dir, "journal.db");
	const s = startServer(t, dbPath);
	const reg = await s.tool("register_project", { name: "p", root_path: "/tmp/p" });
	assert.ok(reg.ok, reg.error);
	assert.ok(
		(await s.tool("draft_task", { task_id: "p/1", project: "p", title: "т", task_text: "x" })).ok,
	);

	// подмена: тот же путь, другой файл (другой inode)
	const swapped = join(dir, "journal.db.swapped");
	copyFileSync(dbPath, swapped);
	renameSync(dbPath, join(dir, "journal.db.moved"));
	renameSync(swapped, dbPath);
	const before = counts(dbPath);

	const r = await s.tool("draft_task", {
		task_id: "p/2",
		project: "p",
		title: "т2",
		task_text: "y",
	});
	assert.equal(r.ok, false);
	assert.equal(r.error, `Ошибка: ${REFUSAL}`, "обёртка MCP добавляет префикс «Ошибка: »");
	assert.deepEqual(counts(dbPath), before, "в подменённый файл ничего не записано");

	// файла нет совсем
	renameSync(dbPath, join(dir, "journal.db.gone"));
	const r2 = await s.tool("draft_task", {
		task_id: "p/3",
		project: "p",
		title: "т3",
		task_text: "z",
	});
	assert.equal(r2.ok, false);
	assert.equal(r2.error, `Ошибка: ${REFUSAL}`);
	assert.equal(existsSync(dbPath), false, "файл базы не воссоздан");
	await s.stop();
});

test("ошибка посреди миграции: откат, исходные данные целы, сервер падает с текстом", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "actari-inplace-"));
	const { dbPath, db } = makeLegacyDb(dir, {
		extra: (d, ins) => {
			// событие о незарегистрированном проекте (guard снят): при переигрывании guard
			// сработает посреди переноса — откат обязан вернуть всё как было
			d.exec("DROP TRIGGER guard_project_registered");
			ins.run(
				"ghost/t1",
				"TaskDrafted",
				JSON.stringify({ project: "ghost", title: "г", task_text: "x" }),
			);
		},
	});
	const before = {
		events: db.prepare("SELECT count(*) n FROM events").get().n,
		tasks: db.prepare("SELECT count(*) n FROM tasks").get().n,
		sql: db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get().sql,
	};
	db.close();

	const s = startServer(t, dbPath);
	const code = await s.exited;
	assert.notEqual(code, 0, "сервер упал");
	assert.match(s.getStderr(), /не удалось обновить схему журнала/);

	const d = new DatabaseSync(dbPath, { readOnly: true });
	assert.equal(d.prepare("SELECT count(*) n FROM events").get().n, before.events);
	assert.equal(d.prepare("SELECT count(*) n FROM tasks").get().n, before.tasks);
	assert.equal(
		d.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get().sql,
		before.sql,
	);
	d.close();
});

test("повторный запуск на уже обновлённой базе — без действий и без нового бэкапа", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "actari-inplace-"));
	const { dbPath, db } = makeLegacyDb(dir);
	db.close();
	const first = startServer(t, dbPath);
	await first.tool("list_tasks", {});
	await first.stop();
	assert.equal(baks(dir).length, 1);

	const second = startServer(t, dbPath);
	await second.tool("list_tasks", {});
	assert.doesNotMatch(second.getStderr(), /перенесено/);
	await second.stop();
	assert.equal(baks(dir).length, 1, "нового бэкапа нет");
});
