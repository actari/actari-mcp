// Скилл едет внутри пакета: один протокольный, frontmatter корректен,
// ролевых скиллов нет, каталог skills/ входит в files-whitelist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("единственный скилл actari: frontmatter, протокол, ссылка на политику", () => {
	assert.deepEqual(readdirSync(join(ROOT, "skills")), ["actari"]);
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
