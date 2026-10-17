// Формат ADR: разбор разделов и проверка в record_artifact kind=adr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ADR_FORMAT_HINT, parseAdrSections } from "../adr.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");

function startClient(t) {
	const dir = mkdtempSync(join(tmpdir(), "actari-adr-"));
	const dbPath = join(dir, "test.db");
	const child = spawn(process.execPath, [SERVER], {
		env: { ...process.env, ACTARI_DB: dbPath },
		stdio: ["pipe", "pipe", "inherit"],
	});
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
		return msg.result.isError ? { ok: false, error: text } : { ok: true, data: JSON.parse(text) };
	};
	return { call, tool, dbPath };
}

const countArtifacts = (dbPath) => {
	const db = new DatabaseSync(dbPath);
	try {
		return db.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n;
	} finally {
		db.close();
	}
};

test("parseAdrSections: русские заголовки ## разбираются в четыре поля", () => {
	const r = parseAdrSections(
		"## Контекст\nНужна очередь.\n\n## Решение\nБерём BullMQ.\n\n## Последствия\nЗависим от Redis.\n\n## Альтернативы\nSQS.\n",
	);
	assert.deepEqual(r, {
		context: "Нужна очередь.",
		decision: "Берём BullMQ.",
		consequences: "Зависим от Redis.",
		alternatives: "SQS.",
	});
});

test("parseAdrSections: английские заголовки ### и все синонимы альтернатив", () => {
	const r = parseAdrSections(
		"### Context\nA\n### Decision\nB\n#### Consequences\nC\n# Considered options\nD",
	);
	assert.deepEqual(r, { context: "A", decision: "B", consequences: "C", alternatives: "D" });
	assert.equal(parseAdrSections("## Рассмотренные альтернативы\nX").alternatives, "X");
	assert.equal(parseAdrSections("## Alternatives\nY").alternatives, "Y");
});

test("parseAdrSections: двоеточие, пробелы и регистр в заголовке", () => {
	const r = parseAdrSections("## КОНТЕКСТ:  \nA\n### решение:\nB");
	assert.equal(r.context, "A");
	assert.equal(r.decision, "B");
});

test("parseAdrSections: текст до первого заголовка отбрасывается", () => {
	const r = parseAdrSections("Преамбула\n\n## Контекст\nA\n## Решение\nB");
	assert.equal(r.context, "A");
	assert.equal(r.decision, "B");
});

test("parseAdrSections: пустой раздел даёт null", () => {
	const r = parseAdrSections(
		"## Контекст\nA\n## Решение\nB\n## Последствия\n\n## Альтернативы\n   \n",
	);
	assert.equal(r.consequences, null);
	assert.equal(r.alternatives, null);
});

test("parseAdrSections: повтор раздела — побеждает первый", () => {
	const r = parseAdrSections("## Решение\nпервое\n## Контекст\nA\n## Решение\nвторое");
	assert.equal(r.decision, "первое");
});

test("parseAdrSections: нераспознанный заголовок остаётся внутри раздела, жирный текст не заголовок", () => {
	const r = parseAdrSections("## Контекст\nA\n### Детали\nещё\n## Решение\n**Решение**\nB");
	assert.equal(r.context, "A\n### Детали\nещё");
	assert.equal(r.decision, "**Решение**\nB");
	const none = parseAdrSections("**Решение**\nБерём X");
	assert.equal(none.decision, null);
	assert.equal(none.context, null);
});

test("ADR_FORMAT_HINT: текст ошибки и шаблон из четырёх разделов", () => {
	assert.ok(
		ADR_FORMAT_HINT.startsWith(
			"ADR не записан: нужны разделы «Контекст» и «Решение» (заголовки markdown; «Последствия» и «Альтернативы» — по желанию). Пример:",
		),
	);
	for (const h of ["## Контекст", "## Решение", "## Последствия", "## Альтернативы"]) {
		assert.ok(ADR_FORMAT_HINT.includes(h), h);
	}
});

test("record_artifact kind=adr без «Решения» отклоняется, артефакта нет", async (t) => {
	const c = startClient(t);
	await c.tool("register_project", { name: "adr-demo", root_path: "/tmp/adr-demo" });
	const r = await c.tool("record_artifact", {
		project: "adr-demo",
		kind: "adr",
		title: "Очередь",
		body: "## Контекст\nНужна очередь.",
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /«Контекст» и «Решение»/);
	assert.equal(countArtifacts(c.dbPath), 0);
});

test("record_artifact kind=adr без «Контекста» отклоняется, артефакта нет", async (t) => {
	const c = startClient(t);
	await c.tool("register_project", { name: "adr-demo", root_path: "/tmp/adr-demo" });
	const r = await c.tool("record_artifact", {
		project: "adr-demo",
		kind: "adr",
		title: "Очередь",
		body: "## Решение\nБерём BullMQ.",
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /«Контекст» и «Решение»/);
	assert.equal(countArtifacts(c.dbPath), 0);
});

test("record_artifact kind=adr с пустым «Решением» отклоняется", async (t) => {
	const c = startClient(t);
	await c.tool("register_project", { name: "adr-demo", root_path: "/tmp/adr-demo" });
	const r = await c.tool("record_artifact", {
		project: "adr-demo",
		kind: "adr",
		title: "Очередь",
		body: "## Контекст\nA\n## Решение\n\n",
	});
	assert.equal(r.ok, false);
	assert.equal(countArtifacts(c.dbPath), 0);
});

test("record_artifact kind=adr с двумя разделами записывается (русские и английские заголовки)", async (t) => {
	const c = startClient(t);
	await c.tool("register_project", { name: "adr-demo", root_path: "/tmp/adr-demo" });
	let r = await c.tool("record_artifact", {
		project: "adr-demo",
		kind: "adr",
		title: "Очередь",
		body: "## Контекст\nНужна очередь.\n\n## Решение\nБерём BullMQ.",
	});
	assert.equal(r.ok, true, r.error);
	assert.equal(r.data.kind, "adr");
	r = await c.tool("record_artifact", {
		project: "adr-demo",
		kind: "adr",
		title: "Queue",
		body: "### Context\nNeed a queue.\n### Decision\nUse BullMQ.",
	});
	assert.equal(r.ok, true, r.error);
	assert.equal(countArtifacts(c.dbPath), 2);
});

test("record_artifact kind=decision без разделов проходит", async (t) => {
	const c = startClient(t);
	await c.tool("register_project", { name: "adr-demo", root_path: "/tmp/adr-demo" });
	const r = await c.tool("record_artifact", {
		project: "adr-demo",
		kind: "decision",
		title: "Решение",
		body: "принято в обсуждении",
	});
	assert.equal(r.ok, true, r.error);
});

test("описания record_artifact, submit_report и accept упоминают adr", async (t) => {
	const c = startClient(t);
	const tools = (await c.call("tools/list")).result.tools;
	const desc = (name) => tools.find((x) => x.name === name).description;
	assert.match(desc("record_artifact"), /kind=adr|kind: adr|adr/i);
	assert.match(desc("record_artifact"), /Контекст/);
	assert.match(desc("record_artifact"), /task_id/);
	assert.match(desc("submit_report"), /kind=adr/);
	assert.match(desc("accept"), /записаны как adr/);
	const kind = tools.find((x) => x.name === "record_artifact").inputSchema.properties.kind;
	assert.match(kind.description, /adr/);
	assert.match(kind.description, /Контекст/);
});
