// Прогон первой фичи на чистом окружении: пакет берётся из `npm pack` (ровно то, что
// уедет в npm), HOME пустой, облака нет, сервер — по stdio из распакованного архива.
// Проверяет обещание README «First feature in 10 minutes» и скилла actari:feature:
// имена инструментов в скилле существуют, а локальный цикл доходит до ACCEPTED и выпуска.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanEnv, startMcp } from "./support/intent-cloud.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

// Не инструменты: параметры, значения и роли, которые скилл пишет в обратных кавычках.
// Список короткий и явный: опечатка в имени инструмента в него не попадёт и будет поймана.
const NOT_TOOLS = new Set([
	"actari",
	"intent_task_id",
	"task_text",
	"task_id",
	"subagent",
	"inline",
	"rework",
	"failed",
	"ref",
	"notes",
]);

// Имя инструмента в скилле: `name` или `name { ... }`; остальные спаны (команды,
// `<slug>`, `mcp__actari__*`, `Lenient`) — не вызовы инструментов.
function toolNamesIn(text) {
	const names = new Set();
	for (const [, span] of text.matchAll(/`([^`\n]*)`/g)) {
		const m = span.match(/^([a-z]+(?:_[a-z]+)*)(?: \{.*\})?$/);
		if (m) names.add(m[1]);
	}
	return names;
}

test("quickstart: npm-архив, пустой HOME, локальный цикл до ACCEPTED и выпуска", async (t) => {
	const tmp = mkdtempSync(join(tmpdir(), "actari-quickstart-"));

	// 1. Пакет ровно как в npm: pack → распаковка.
	const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--silent"], {
		cwd: PKG,
		encoding: "utf8",
	});
	assert.equal(pack.status, 0, pack.stderr);
	const tarball = join(tmp, pack.stdout.trim().split("\n").pop());
	assert.ok(existsSync(tarball), `архив ${tarball} создан`);
	const unpacked = join(tmp, "unpacked");
	mkdirSync(unpacked);
	const untar = spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { encoding: "utf8" });
	assert.equal(untar.status, 0, untar.stderr);
	const pkgDir = join(unpacked, "package");
	for (const file of ["server.mjs", "skills/feature/SKILL.md", "skills/actari/SKILL.md"]) {
		assert.ok(existsSync(join(pkgDir, file)), `в архиве есть ${file}`);
	}
	assert.equal(existsSync(join(pkgDir, "test")), false, "тестов в архиве нет");

	// 2. Чистое окружение: пустой HOME, без ACTARI_DB/ACTARI_SCHEMA, репозиторий без истории.
	const home = mkdtempSync(join(tmpdir(), "actari-quickstart-home-"));
	const repo = mkdtempSync(join(tmpdir(), "actari-quickstart-repo-"));
	const git = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
	assert.equal(git.status, 0, git.stderr);
	const env = cleanEnv({ HOME: home });
	delete env.ACTARI_SCHEMA;
	assert.equal(env.ACTARI_DB, undefined);

	const c = startMcp(t, env, join(pkgDir, "server.mjs"));

	// 3. Каждый инструмент из скилла feature есть в tools/list.
	const list = await c.call("tools/list", {});
	const available = new Set(list.result.tools.map((tool) => tool.name));
	const skill = readFileSync(join(pkgDir, "skills", "feature", "SKILL.md"), "utf8");
	const named = [...toolNamesIn(skill)].filter((name) => !NOT_TOOLS.has(name));
	assert.ok(named.length >= 15, `в скилле найдено слишком мало инструментов: ${named.join(", ")}`);
	for (const name of named) {
		assert.ok(available.has(name), `скилл feature называет «${name}», такого инструмента нет`);
	}

	// 4. Локальный цикл: политика → проект → намерение → задача → отчёт → приёмка → выпуск.
	// Шаг 1 скилла: проекта ещё нет → resolve_project пуст → register_project.
	// get_policy на незарегистрированный проект отказывает, поэтому скилл зовёт его с шага 2.
	let r = await c.tool("resolve_project", { path: repo });
	assert.equal(r.ok, true, r.text);
	assert.equal(r.data.matches.length, 0, "в пустом журнале проекта нет");

	r = await c.tool("register_project", { name: "demo", root_path: repo });
	assert.equal(r.ok, true, r.text);

	r = await c.tool("get_policy", { project: "demo" });
	assert.equal(r.ok, true, r.text);

	r = await c.tool("record_artifact", {
		project: "demo",
		kind: "note",
		title: "intent: csv-export",
		body: "Экспорт отчёта в CSV.\n\nКритерии:\n- файл скачивается",
	});
	assert.equal(r.ok, true, r.text);

	r = await c.tool("publish_intent", {
		project: "demo",
		slug: "csv-export",
		title: "Экспорт в CSV",
		text: "Экспорт отчёта в CSV.",
		acceptance_criteria: "- файл скачивается",
	});
	assert.equal(r.ok, false, "без облака publish_intent отказывает, цикл идёт локально");

	r = await c.tool("draft_task", {
		project: "demo",
		slug: "csv-export-1",
		title: "Экспорт в CSV",
		task_text: "Добавить экспорт отчёта в CSV.",
	});
	assert.equal(r.ok, true, r.text);
	const taskId = r.data.task_id;
	assert.ok(taskId, "draft_task вернул task_id");

	r = await c.tool("delegate", { task_id: taskId, executor: "inline" });
	assert.equal(r.ok, true, r.text);
	assert.equal(r.data.status, "DELEGATED");

	r = await c.tool("submit_report", {
		task_id: taskId,
		report: "Команда: node --test\nВывод: 3 pass, 0 fail",
	});
	assert.equal(r.ok, true, r.text);
	assert.equal(r.data.status, "REPORTED");

	const acceptance = `acceptance: ${taskId}`;
	r = await c.tool("record_artifact", {
		project: "demo",
		kind: "note",
		task_id: taskId,
		title: acceptance,
		body: "Вердикт: принято. Прогон: 3 pass, 0 fail.",
	});
	assert.equal(r.ok, true, r.text);

	r = await c.tool("accept", { task_id: taskId, evidence: "node --test: 3 pass, 0 fail" });
	assert.equal(r.ok, true, r.text);
	assert.equal(r.data.status, "ACCEPTED");

	r = await c.tool("get_task", { task_id: taskId });
	assert.equal(r.ok, true, r.text);
	assert.equal(r.data.task.status, "ACCEPTED");
	assert.ok(
		r.data.artifacts.some((a) => a.title === acceptance),
		"артефакт acceptance: виден в get_task",
	);

	r = await c.tool("record_release", {
		project: "demo",
		items: ["csv-export"],
		notes: [{ item: "csv-export", title: "Экспорт в CSV", note: "Отчёт можно скачать в CSV" }],
	});
	assert.equal(r.ok, true, r.text);

	// 5. База легла в пустой HOME сама.
	assert.ok(existsSync(join(home, ".actari", "journal.db")), "журнал создан в $HOME/.actari");
});
