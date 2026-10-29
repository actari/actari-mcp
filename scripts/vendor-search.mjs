#!/usr/bin/env node
// Вшивание @actari/search в actari-mcp: собирает пакет и копирует его ES-сборку
// (без eval/ и карт кода) в apps/mcp/vendor/search/. Копия коммитится: npm-пакет и
// GitHub-зеркало не тянут монорепо. Запуск: pnpm --filter actari-mcp vendor:search

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MCP_DIR = dirname(HERE);
export const REPO_ROOT = join(MCP_DIR, "..", "..");
export const SEARCH_DIR = join(REPO_ROOT, "packages", "search");
export const SEARCH_ESM_DIR = join(SEARCH_DIR, "dist", "esm");
export const VENDOR_DIR = join(MCP_DIR, "vendor", "search");

/** Рантайм-файлы пакета: без eval/ (фикстуры и раннер метрик) и без карт кода. */
export function runtimeFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (dir === root && name === "eval") continue;
				walk(full);
			} else if (!name.endsWith(".map")) {
				out.push(relative(root, full));
			}
		}
	};
	if (existsSync(root)) walk(root);
	return out;
}

export function buildSearchPackage() {
	const res = spawnSync("pnpm", ["--filter", "@actari/search", "build"], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (res.status !== 0) throw new Error("сборка @actari/search не прошла");
}

export function vendorSearch({ build = true } = {}) {
	if (build) buildSearchPackage();
	if (!existsSync(SEARCH_ESM_DIR)) {
		throw new Error(
			"нет packages/search/dist/esm — собери пакет: pnpm --filter @actari/search build",
		);
	}
	rmSync(VENDOR_DIR, { recursive: true, force: true });
	mkdirSync(VENDOR_DIR, { recursive: true });
	const files = runtimeFiles(SEARCH_ESM_DIR);
	for (const file of files) {
		mkdirSync(dirname(join(VENDOR_DIR, file)), { recursive: true });
		cpSync(join(SEARCH_ESM_DIR, file), join(VENDOR_DIR, file));
	}
	// Лицензия вписанного Snowball-кода едет вместе с ним.
	cpSync(join(SEARCH_DIR, "LICENSE-snowball"), join(VENDOR_DIR, "LICENSE-snowball"));
	return files.length + 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const count = vendorSearch();
	console.log(`vendor/search: скопировано файлов — ${count}`);
}
