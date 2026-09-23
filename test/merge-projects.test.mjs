// Тесты инструмента слияния проектов журнала: пересборка лога с новыми id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { mergeProjects, renameTaskId } from "../tools/merge-projects.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA = readFileSync(join(ROOT, "schema.sql"), "utf8");

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "actari-merge-"));
	const path = join(dir, "src.db");
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	const ev = db.prepare("INSERT INTO events(task_id, type, payload, at) VALUES (?, ?, ?, ?)");
	const at = "2026-01-01 00:00:00";
	const reg = (name) =>
		ev.run(
			"_general",
			"ProjectRegistered",
			JSON.stringify({ name, root_path: `/old/${name}`, cloud_workspace_id: null }),
			at,
		);
	reg("old-a");
	reg("old-b");
	reg("other");
	const draft = (id, project) =>
		ev.run(
			id,
			"TaskDrafted",
			JSON.stringify({ project, title: id, task_text: `текст про old-a/${id}` }),
			at,
		);
	draft("old-a/2026-01-01-x", "old-a");
	draft("old-b/2026-01-02-y", "old-b");
	draft("other/2026-01-03-z", "other");
	ev.run(
		"old-a/2026-01-01-x",
		"TaskLinked",
		JSON.stringify({ to_task_id: "old-b/2026-01-02-y", kind: "relates" }),
		at,
	);
	ev.run(
		"_general",
		"ArtifactRecorded",
		JSON.stringify({ project: "old-a", kind: "note", title: "общая", body: "b" }),
		at,
	);
	ev.run(
		"old-b/2026-01-02-y",
		"ArtifactRecorded",
		JSON.stringify({ project: "old-b", kind: "note", title: "к задаче", body: "b" }),
		at,
	);
	ev.run(
		"old-b/2026-01-02-y",
		"IncidentRecorded",
		JSON.stringify({ description: "d", lesson: "l" }),
		at,
	);
	db.close();
	return { dir, path };
}

const opts = (path, dir) => ({
	src: path,
	out: join(dir, "out.db"),
	from: ["old-a", "old-b"],
	to: "new",
	root: "/new/root",
	workspace: "ws-1",
});

test("renameTaskId: меняет только префикс проекта из from", () => {
	assert.equal(renameTaskId("old-a/2026-01-01-x", ["old-a"], "new"), "new/2026-01-01-x");
	assert.equal(renameTaskId("other/2026-01-03-z", ["old-a"], "new"), "other/2026-01-03-z");
	assert.equal(renameTaskId("old-ab/2026-01-01-x", ["old-a"], "new"), "old-ab/2026-01-01-x");
	assert.equal(renameTaskId("_general", ["old-a"], "new"), "_general");
});

test("mergeProjects: счётчики до и после совпадают, id переписаны, текст не тронут", () => {
	const { dir, path } = fixture();
	const report = mergeProjects(opts(path, dir));
	assert.deepEqual(report.after, report.before);
	assert.equal(report.artifactsIdentical, true);
	assert.equal(report.otherProjectsIdentical, true);
	assert.deepEqual(report.projects, ["new", "other"]);

	const db = new DatabaseSync(join(dir, "out.db"), { readOnly: true });
	const ids = db
		.prepare("SELECT task_id FROM tasks ORDER BY task_id")
		.all()
		.map((r) => r.task_id);
	assert.deepEqual(ids, ["new/2026-01-01-x", "new/2026-01-02-y", "other/2026-01-03-z"]);
	assert.deepEqual(
		{ ...db.prepare("SELECT from_task, to_task FROM task_links").get() },
		{
			from_task: "new/2026-01-01-x",
			to_task: "new/2026-01-02-y",
		},
	);
	assert.equal(db.prepare("SELECT task_id FROM incidents").get().task_id, "new/2026-01-02-y");
	assert.deepEqual(
		db
			.prepare("SELECT project FROM artifacts ORDER BY id")
			.all()
			.map((r) => r.project),
		["new", "new"],
	);
	assert.deepEqual(
		{
			...db
				.prepare("SELECT name, root_path, cloud_workspace_id FROM projects WHERE name = 'new'")
				.get(),
		},
		{ name: "new", root_path: "/new/root", cloud_workspace_id: "ws-1" },
	);
	assert.match(
		db.prepare("SELECT task_text FROM tasks WHERE task_id = 'new/2026-01-01-x'").get().task_text,
		/old-a\//,
	);
	const maxSeq = (p) =>
		new DatabaseSync(p, { readOnly: true }).prepare("SELECT max(seq) m FROM events").get().m;
	assert.equal(maxSeq(join(dir, "out.db")), maxSeq(path));
});

test("mergeProjects: отказы — out существует, неизвестный from, коллизия slug", () => {
	const { dir, path } = fixture();
	mergeProjects(opts(path, dir));
	assert.throws(() => mergeProjects(opts(path, dir)), /существует/);
	assert.throws(
		() => mergeProjects({ ...opts(path, dir), out: join(dir, "o2.db"), from: ["nope"] }),
		/nope/,
	);
	// Настоящая коллизия: у other появляется задача с тем же slug, что у old-a.
	const db = new DatabaseSync(path);
	db.prepare("INSERT INTO events(task_id, type, payload, at) VALUES (?, ?, ?, ?)").run(
		"other/2026-01-01-x",
		"TaskDrafted",
		JSON.stringify({ project: "other", title: "дубль slug", task_text: "t" }),
		"2026-01-01 00:00:00",
	);
	db.close();
	assert.throws(
		() =>
			mergeProjects({ ...opts(path, dir), out: join(dir, "o3.db"), from: ["old-a"], to: "other" }),
		/Коллизия/,
	);
	assert.equal(existsSync(join(dir, "o3.db")), false);
});

test("mergeProjects: повторный прогон на результате ничего не пишет", () => {
	const { dir, path } = fixture();
	mergeProjects(opts(path, dir));
	const again = { ...opts(join(dir, "out.db"), dir), out: join(dir, "again.db") };
	assert.throws(() => mergeProjects(again), /old-a/);
	assert.equal(existsSync(join(dir, "again.db")), false);
});
