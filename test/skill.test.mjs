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
	for (const banned of ["orchestrator's own test run", "never accept your own"]) {
		assert.ok(!text.includes(banned), `методологии в протокольном скилле нет: ${banned}`);
	}

	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	assert.ok(
		pkg.files.some((entry) => entry.replace(/\/$/, "") === "skills"),
		"skills/ есть в files-whitelist",
	);
});
