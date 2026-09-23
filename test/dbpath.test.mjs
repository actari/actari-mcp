// Тесты резолва пути к базе журнала (resolveDbPath).
// Две ветки: ACTARI_DB перекрывает всё → иначе ~/.actari/journal.db.
// Ничего не пишем в настоящий HOME: чистая функция получает подменённый
// homedir, а живой старт сервера идёт по временной директории.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_DB_DIR, DEFAULT_DB_FILE, resolveDbPath } from "../sync.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");

const HOME = "/home/tester";

test("resolveDbPath: ACTARI_DB перекрывает дефолт", () => {
	const path = resolveDbPath({
		env: { ACTARI_DB: "/tmp/explicit/db.sqlite" },
		homedir: HOME,
	});
	assert.equal(path, "/tmp/explicit/db.sqlite");
});

test("resolveDbPath: дефолт — ~/.actari/journal.db", () => {
	const path = resolveDbPath({ env: {}, homedir: HOME });
	assert.equal(path, join(HOME, ".actari", "journal.db"));
	assert.equal(path, join(HOME, DEFAULT_DB_DIR, DEFAULT_DB_FILE));
});

test("resolveDbPath: дефолтный homedir берётся из системы", async () => {
	// Отдельный процесс с суррогатным HOME: проверяем проводку дефолта
	// os.homedir(), не трогая настоящую домашнюю директорию.
	const home = mkdtempSync(join(tmpdir(), "actari-home-"));
	const out = await new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { resolveDbPath } from ${JSON.stringify(join(ROOT, "sync.mjs"))};
				 process.stdout.write(resolveDbPath({ env: {} }));`,
			],
			{
				env: { ...process.env, HOME: home, ACTARI_DB: "" },
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => (buf += c));
		child.on("error", reject);
		child.on("close", () => resolve(buf));
	});
	assert.equal(out, join(home, ".actari", "journal.db"));
	assert.equal(existsSync(join(home, ".actari")), false, "резолв ничего не создаёт");
});

test("чистый старт: сервер поднимает базу по дефолту бренда в пустом HOME", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "actari-fresh-"));
	const dbPath = resolveDbPath({ env: {}, homedir: home });
	assert.equal(dbPath, join(home, ".actari", "journal.db"));
	assert.equal(existsSync(dirname(dbPath)), false, "директории заведомо нет");

	// Путь отдаём явным ACTARI_DB: сервер в тестах никогда не резолвит
	// настоящий HOME, чтобы не задеть живой журнал.
	const child = spawn(process.execPath, [SERVER], {
		env: { ...process.env, ACTARI_DB: dbPath },
		stdio: ["pipe", "pipe", "inherit"],
	});
	t.after(() => child.kill());

	const ready = new Promise((resolve) => {
		child.stdout.setEncoding("utf8");
		child.stdout.once("data", resolve);
	});
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
	);
	const line = JSON.parse(await ready);

	assert.equal(line.result.serverInfo.name, "actari");
	assert.equal(existsSync(dbPath), true, "база создана в новой директории бренда");
});
