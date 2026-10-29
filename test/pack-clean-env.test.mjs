// Чистое окружение (задача search-engine-5, шаг 7): npm pack → распаковка вне монорепо →
// запуск server.mjs по stdio → initialize и search_precedents отвечают. Размер tarball и время старта — в вывод.
// Запуск: node --test test/pack-clean-env.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MCP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Простой клиент stdio: строка JSON-RPC на запрос. */
function startStdio(serverPath, env) {
	const child = spawn(process.execPath, [serverPath], {
		cwd: dirname(serverPath),
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
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
		new Promise((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(
				() => reject(new Error(`таймаут ${method}; stderr: ${stderr}`)),
				20000,
			);
			pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	return { child, call, stderr: () => stderr };
}

test("npm pack → чистый каталог вне монорепо → server.mjs отвечает на initialize и search_precedents", async (t) => {
	const out = mkdtempSync(join(tmpdir(), "actari-pack-"));
	const pack = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], {
		cwd: MCP_DIR,
		encoding: "utf8",
	});
	assert.equal(pack.status, 0, `npm pack: ${pack.stderr}`);
	const info = JSON.parse(pack.stdout)[0];
	const tarball = join(out, info.filename);
	const size = statSync(tarball).size;
	const files = info.files.map((f) => f.path);
	console.log(
		`# tarball ${info.filename}: ${size} байт (${(size / 1024).toFixed(1)} КБ), в распакованном виде ${info.unpackedSize} байт, файлов ${files.length}`,
	);
	assert.ok(files.includes("search-index.mjs"), "search-index.mjs в пакете");
	assert.ok(files.includes("vendor/search/index.js"), "вшитый пакет в tarball");
	assert.ok(
		!files.some((f) => f.includes("/eval/") || f.endsWith(".map")),
		"без eval/ и карт кода",
	);
	assert.ok(
		!files.some((f) => f.startsWith("scripts/") || f.startsWith("test/")),
		"без скриптов и тестов",
	);

	const extract = mkdtempSync(join(tmpdir(), "actari-unpacked-"));
	const tar = spawnSync("tar", ["-xzf", tarball, "-C", extract]);
	assert.equal(tar.status, 0);
	const serverPath = join(extract, "package", "server.mjs");
	assert.ok(existsSync(serverPath));
	assert.ok(!readdirSync(join(extract, "package")).includes("node_modules"), "без зависимостей");

	const home = mkdtempSync(join(tmpdir(), "actari-home-"));
	const env = { PATH: process.env.PATH, HOME: home, ACTARI_DB: join(home, "journal.db") };
	const started = Date.now();
	const c = startStdio(serverPath, env);
	t.after(() => c.child.kill());
	const init = await c.call("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "t", version: "0" },
	});
	const startMs = Date.now() - started;
	assert.equal(init.result.serverInfo.name, "actari");

	const reg = await c.call("tools/call", {
		name: "register_project",
		arguments: { name: "demo", root_path: join(home, "demo") },
	});
	assert.ok(!reg.result.isError, reg.result.content[0].text);
	await c.call("tools/call", {
		name: "draft_task",
		arguments: {
			project: "demo",
			slug: "a",
			title: "Ранги расписания",
			task_text: "перенормировать ранги ганта",
		},
	});
	const search = await c.call("tools/call", {
		name: "search_precedents",
		arguments: { query: "ранг расписание" },
	});
	assert.ok(!search.result.isError, search.result.content[0].text);
	const data = JSON.parse(search.result.content[0].text);
	assert.equal(data.tasks.length, 1, "распакованный пакет ищет с морфологией");
	const firstSearchMs = Date.now() - started;
	console.log(
		`# старт до ответа initialize: ${startMs} мс; до первого ответа search_precedents: ${firstSearchMs} мс`,
	);
	assert.equal(c.stderr(), "", `в stderr чистого запуска ничего нет: ${c.stderr()}`);
});
