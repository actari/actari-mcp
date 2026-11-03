// Скиллы едут внутри пакета: протокольный actari и методологический feature,
// frontmatter корректен, остальных ролевых скиллов нет, каталог skills/ входит в files-whitelist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("скиллы actari и feature: frontmatter, протокол, ссылка на политику", () => {
	assert.deepEqual(readdirSync(join(ROOT, "skills")).sort(), ["actari", "feature"]);
	const path = join(ROOT, "skills", "actari", "SKILL.md");
	assert.equal(existsSync(path), true);

	const text = readFileSync(path, "utf8");
	const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(frontmatter, "есть frontmatter");
	assert.match(frontmatter[1], /^name: actari$/m);
	assert.match(frontmatter[1], /^description: .+/m);
	assert.ok(text.includes("REPORTED"), "семантика статусов описана");
	assert.ok(text.includes("get_policy"), "правила — в политике");
	assert.match(text, /^## ADR$/m, "раздел про ADR есть");
	assert.ok(text.includes('kind: "adr"'), "ADR: как записывать");
	assert.match(text, /## Context[\s\S]*## Decision/, "ADR: формат с обязательными разделами");
	for (const banned of ["orchestrator's own test run", "never accept your own"]) {
		assert.ok(!text.includes(banned), `методологии в протокольном скилле нет: ${banned}`);
	}

	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	assert.ok(
		pkg.files.some((entry) => entry.replace(/\/$/, "") === "skills"),
		"skills/ есть в files-whitelist",
	);
});

test("Getting started: раздел стоит раньше Statuses и называет первые инструменты", () => {
	const text = readFileSync(join(ROOT, "skills", "actari", "SKILL.md"), "utf8");
	const start = text.search(/^## Getting started$/m);
	assert.ok(start >= 0, "есть раздел ## Getting started");
	assert.ok(start < text.search(/^## Statuses$/m), "Getting started раньше Statuses");

	const rest = text.slice(start + 1);
	const next = rest.search(/^## /m);
	const section = next === -1 ? rest : rest.slice(0, next);
	for (const tool of ["register_project", "publish_intent", "inbox", "take", "draft_task"]) {
		assert.ok(section.includes(tool), `в Getting started есть ${tool}`);
	}
});

function section(text, heading) {
	const start = text.search(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
	assert.ok(start >= 0, `есть раздел ${heading}`);
	const rest = text.slice(start + 1);
	const next = rest.search(/^## /m);
	return next === -1 ? rest : rest.slice(0, next);
}

test("скилл feature: frontmatter, шаги цикла, приёмка не самим исполнителем", () => {
	const text = readFileSync(join(ROOT, "skills", "feature", "SKILL.md"), "utf8");
	const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(frontmatter, "есть frontmatter");
	assert.match(frontmatter[1], /^name: feature$/m);
	assert.match(frontmatter[1], /^description: .+/m);
	assert.ok(frontmatter[1].includes("do it through actari"), "триггер en");
	assert.ok(frontmatter[1].includes("сделай через actari"), "триггер ru");
	assert.ok(text.split("\n").length <= 250, "скилл не длиннее 250 строк");

	const headings = [
		"## When to use",
		"## Policy first",
		"## 1. Project",
		"## 2. Intent",
		"## 3. From the cloud",
		"## 4. Tasks",
		"## 5. Acceptance",
		"## 6. Summary",
		"## 7. Release",
	];
	let last = -1;
	for (const heading of headings) {
		const at = text.search(new RegExp(`^${heading.replace(".", "\\.")}$`, "m"));
		assert.ok(at > last, `${heading} есть и идёт после предыдущего`);
		last = at;
	}

	for (const needle of [
		"get_policy",
		"register_project",
		"publish_intent",
		"inbox",
		"take",
		"draft_task",
		"delegate",
		"submit_report",
		"accept",
		"record_release",
		"intent: <slug>",
		"acceptance: <task_id>",
	]) {
		assert.ok(text.includes(needle), `в скилле feature есть ${needle}`);
	}

	const acceptance = section(text, "## 5. Acceptance");
	for (const needle of ["subagent", "request_rework", "mark_failed", "intent_status"]) {
		assert.ok(acceptance.includes(needle), `в приёмке есть ${needle}`);
	}
	assert.match(acceptance, /without subagents[\s\S]*human/i, "без субагентов — человек");

	const release = section(text, "## 7. Release");
	for (const needle of ["record_release", "notes", "sync"]) {
		assert.ok(release.includes(needle), `в выпуске есть ${needle}`);
	}
});

test("скилл feature: токены AI через log_usage", () => {
	const text = readFileSync(join(ROOT, "skills", "feature", "SKILL.md"), "utf8");
	const tasks = section(text, "## 4. Tasks");
	for (const needle of [
		"log_usage",
		'executor: "subagent"',
		"usage_file",
		"session",
		"claude-code",
		"opencode",
		"codex",
		"токены не записаны: работа шла в этом чате",
		"токены: клиент не отдал",
		"subagent_tokens",
	]) {
		assert.ok(tasks.includes(needle), `в «4. Tasks» есть ${needle}`);
	}
	const acceptance = section(text, "## 5. Acceptance");
	assert.ok(acceptance.includes("log_usage"), "в приёмке есть log_usage");
	assert.ok(acceptance.includes("acceptance"), "в приёмке есть роль acceptance");
	assert.ok(text.split("\n").length <= 250, "скилл не длиннее 250 строк");
});

test("скилл actari и README описывают log_usage", () => {
	const skill = readFileSync(join(ROOT, "skills", "actari", "SKILL.md"), "utf8");
	assert.ok(skill.includes("log_usage"), "в скилле actari есть log_usage");
	assert.ok(skill.includes("usage_file"), "в скилле actari есть usage_file");
	for (const needle of ["session", "claude-code", "opencode", "codex"]) {
		assert.ok(skill.includes(needle), `в скилле actari есть ${needle}`);
	}
	const readme = readFileSync(join(ROOT, "README.md"), "utf8");
	assert.ok(readme.includes("log_usage"), "в README есть log_usage");
	assert.ok(readme.includes("usage_file"), "в README есть usage_file");
	for (const needle of ["session", "claude-code", "opencode", "codex"]) {
		assert.ok(readme.includes(needle), `в README есть ${needle}`);
	}
});

test("скилл actari ссылается на feature", () => {
	const text = readFileSync(join(ROOT, "skills", "actari", "SKILL.md"), "utf8");
	assert.ok(section(text, "## Getting started").includes("actari:feature"));
});

test("README: первая фича за 10 минут", () => {
	const text = readFileSync(join(ROOT, "README.md"), "utf8");
	const quick = text.search(/^## Quick start$/m);
	const first = text.search(/^## First feature in 10 minutes$/m);
	const install = text.search(/^## Install$/m);
	assert.ok(quick >= 0 && first > quick && first < install, "раздел между Quick start и Install");
	assert.match(text, /^### Nothing showed up\?$/m);
	assert.ok(text.includes("--skill feature"));
	assert.ok(text.includes("do it through actari"));
	assert.ok(text.includes("sync_scope"));
});

test("версия пакета одна во всех манифестах", () => {
	const read = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), "utf8"));
	const version = read("package.json").version;
	assert.match(version, /^\d+\.\d+\.\d+$/);
	assert.equal(read(".claude-plugin", "plugin.json").version, version, "plugin.json");
	assert.equal(
		read(".claude-plugin", "marketplace.json").plugins[0].version,
		version,
		"apps/mcp marketplace.json",
	);
	// Корневой маркетплейс есть только в монорепо; в зеркале пакета его нет.
	const rootMarketplace = join(ROOT, "..", "..", ".claude-plugin", "marketplace.json");
	if (existsSync(rootMarketplace)) {
		assert.equal(
			JSON.parse(readFileSync(rootMarketplace, "utf8")).plugins[0].version,
			version,
			"корневой marketplace.json",
		);
	}
});

test("скилл feature: шаг «3b. Architecture» между облаком и задачами", () => {
	const text = readFileSync(join(ROOT, "skills", "feature", "SKILL.md"), "utf8");
	const at = text.search(/^## 3b\. Architecture$/m);
	assert.ok(at > text.search(/^## 3\. From the cloud$/m), "шаг 3b идёт после шага 3");
	assert.ok(at < text.search(/^## 4\. Tasks$/m), "шаг 3b идёт до шага 4");

	const step = section(text, "## 3b. Architecture");
	for (const needle of [
		"architecture_review",
		"project, slug",
		"## Архитектура",
		"ADR",
		"ответьте на вкладке «Архитектура» фичи или ответом боту",
		"queued",
		"up to 3 times with 60 s",
		"no_map",
		"unavailable",
		"architecture_check",
	]) {
		assert.ok(step.includes(needle), `в шаге 3b есть ${needle}`);
	}
	assert.match(step, /plan|tasks/i, "пока вопросы открыты, задачи не строятся");
	assert.match(
		section(text, "## 2. Intent"),
		/3b/,
		"шаг 2 называет остановку на вопросах архитектора",
	);
	assert.ok(text.split("\n").length <= 250, "скилл не длиннее 250 строк");

	const acceptance = section(text, "## 5. Acceptance");
	for (const needle of ["architecture_check", "architecture:", "adr:<id>", "блокирует"]) {
		assert.ok(acceptance.includes(needle), `в приёмке есть ${needle}`);
	}
});

test("скилл actari описывает architecture_review и architecture_check", () => {
	const text = readFileSync(join(ROOT, "skills", "actari", "SKILL.md"), "utf8");
	const tools = section(text, "## Tools");
	assert.ok(tools.includes("architecture_review"), "architecture_review в таблице инструментов");
	assert.ok(tools.includes("architecture_check"), "architecture_check в таблице инструментов");
	const at = text.search(/^## Architecture$/m);
	assert.ok(at >= 0, "есть раздел ## Architecture");
	const part = section(text, "## Architecture");
	for (const needle of ["slug", "text", "task_id", "no_map", "queued", "unavailable"]) {
		assert.ok(part.includes(needle), `в разделе Architecture есть ${needle}`);
	}
});

test("скилл feature: шаг «Documentation» перед сводкой и строка «Документация:»", () => {
	const text = readFileSync(join(ROOT, "skills", "feature", "SKILL.md"), "utf8");
	const at = text.search(/^## 5b\. Documentation$/m);
	assert.ok(at > text.search(/^## 5\. Acceptance$/m), "шаг 5b идёт после приёмки");
	assert.ok(at < text.search(/^## 6\. Summary$/m), "шаг 5b идёт до сводки и передачи в релиз");

	const step = section(text, "## 5b. Documentation");
	for (const needle of ["content/docs", "Документация:", "не нужна"]) {
		assert.ok(step.includes(needle), `в «5b. Documentation» есть ${needle}`);
	}
	assert.ok(text.split("\n").length <= 250, "скилл не длиннее 250 строк");
});
