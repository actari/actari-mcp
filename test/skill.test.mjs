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
