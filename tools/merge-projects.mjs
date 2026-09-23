#!/usr/bin/env node
// Слияние проектов журнала: лог append-only, поэтому переименовать задачи
// на месте нельзя. События переигрываются по seq в новую базу, триггеры
// строят проекции заново. Переписываются только структурные поля: id задач,
// project, to_task_id и регистрации проектов. Свободный текст не трогается.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { INTENT_CACHE_DDL } from "../intent.mjs";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_PATH = join(PACKAGE_DIR, "schema.sql");

export function renameTaskId(taskId, from, to) {
	for (const name of from) {
		if (taskId.startsWith(`${name}/`)) return `${to}/${taskId.slice(name.length + 1)}`;
	}
	return taskId;
}

export function rewriteEvent(event, { from, to, root, workspace }) {
	const payload = JSON.parse(event.payload);
	if (event.type === "ProjectRegistered" && from.includes(payload.name)) {
		return {
			...event,
			payload: JSON.stringify({ name: to, root_path: root, cloud_workspace_id: workspace ?? null }),
		};
	}
	if (from.includes(payload.project)) payload.project = to;
	if (event.type === "TaskLinked" && typeof payload.to_task_id === "string") {
		payload.to_task_id = renameTaskId(payload.to_task_id, from, to);
	}
	return {
		...event,
		task_id: renameTaskId(event.task_id, from, to),
		payload: JSON.stringify(payload),
	};
}

function counts(db) {
	const n = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
	return {
		events: n("events"),
		tasks: n("tasks"),
		artifacts: n("artifacts"),
		incidents: n("incidents"),
		links: n("task_links"),
	};
}

function slug(taskId) {
	return taskId.slice(taskId.indexOf("/") + 1);
}

// intent_cache/intent_meta — служебный кэш намерений (intent.mjs), не события:
// схема.sql их не создаёт, сервер добавляет их поверх при старте. В свежесобранной
// базе-фикстуре (только schema.sql) этих таблиц нет вовсе — тогда копировать нечего.
function copyCacheTables(source, target) {
	const sourceTables = new Set(
		source
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((r) => r.name),
	);
	for (const table of ["intent_cache", "intent_meta"]) {
		if (!sourceTables.has(table)) continue;
		target.exec(INTENT_CACHE_DDL);
		const rows = source.prepare(`SELECT * FROM ${table}`).all();
		for (const row of rows) {
			const cols = Object.keys(row);
			target
				.prepare(
					`INSERT INTO ${table}(${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
				)
				.run(...cols.map((c) => row[c]));
		}
	}
}

export function mergeProjects({ src, out, from, to, root, workspace = null }) {
	if (existsSync(out)) throw new Error(`Файл ${out} уже существует`);
	const source = new DatabaseSync(src, { readOnly: true });
	try {
		const registered = new Set(
			source
				.prepare("SELECT name FROM projects")
				.all()
				.map((r) => r.name),
		);
		const missing = from.filter((name) => !registered.has(name));
		if (missing.length) throw new Error(`Нет в реестре: ${missing.join(", ")}`);

		const targets = new Set([...from, to]);
		const seen = new Map();
		for (const { task_id, project } of source.prepare("SELECT task_id, project FROM tasks").all()) {
			if (!targets.has(project)) continue;
			const key = slug(task_id);
			if (seen.has(key)) throw new Error(`Коллизия slug ${key}: ${seen.get(key)} и ${task_id}`);
			seen.set(key, task_id);
		}

		const target = new DatabaseSync(out);
		try {
			target.exec(readFileSync(SCHEMA_PATH, "utf8"));
			const insert = target.prepare(
				"INSERT INTO events(seq, task_id, type, payload, at) VALUES (?, ?, ?, ?, ?)",
			);
			target.exec("BEGIN");
			for (const event of source
				.prepare("SELECT seq, task_id, type, payload, at FROM events ORDER BY seq")
				.iterate()) {
				const e = rewriteEvent(event, { from, to, root, workspace });
				insert.run(e.seq, e.task_id, e.type, e.payload, e.at);
			}
			target.exec("COMMIT");
			copyCacheTables(source, target);

			const artifactsOf = (db) =>
				db
					.prepare("SELECT id, kind, title FROM artifacts ORDER BY id")
					.all()
					.map((r) => `${r.id}|${r.kind}|${r.title}`);
			const othersOf = (db) =>
				db
					.prepare(
						"SELECT name, root_path, cloud_workspace_id FROM projects WHERE name NOT IN (SELECT value FROM json_each(?)) ORDER BY name",
					)
					.all(JSON.stringify([...targets]))
					.map((r) => `${r.name}|${r.root_path}|${r.cloud_workspace_id}`);
			const report = {
				before: counts(source),
				after: counts(target),
				projects: target
					.prepare("SELECT name FROM projects ORDER BY name")
					.all()
					.map((r) => r.name),
				artifactsIdentical: artifactsOf(source).join("\n") === artifactsOf(target).join("\n"),
				otherProjectsIdentical: othersOf(source).join("\n") === othersOf(target).join("\n"),
			};
			const leftover = target
				.prepare(
					"SELECT count(*) AS n FROM tasks WHERE project IN (SELECT value FROM json_each(?))",
				)
				.get(JSON.stringify(from)).n;
			if (
				JSON.stringify(report.before) !== JSON.stringify(report.after) ||
				!report.artifactsIdentical ||
				!report.otherProjectsIdentical ||
				leftover !== 0
			) {
				throw new Error(`Проверка не прошла: ${JSON.stringify({ ...report, leftover })}`);
			}
			return report;
		} catch (error) {
			if (target.isOpen) target.close();
			rmSync(out, { force: true });
			rmSync(`${out}-wal`, { force: true });
			rmSync(`${out}-shm`, { force: true });
			throw error;
		} finally {
			if (target.isOpen) target.close();
		}
	} finally {
		source.close();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			db: { type: "string" },
			out: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			root: { type: "string" },
			workspace: { type: "string" },
		},
	});
	try {
		for (const key of ["db", "out", "from", "to", "root"]) {
			if (!values[key]) throw new Error(`Нужен --${key}`);
		}
		const report = mergeProjects({
			src: values.db,
			out: values.out,
			from: values.from
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			to: values.to,
			root: values.root,
			workspace: values.workspace ?? null,
		});
		console.log(JSON.stringify(report, null, 2));
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
