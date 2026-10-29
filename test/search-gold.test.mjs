// Контрольный набор на SQLite (задача search-engine-5, шаг 6): временная база из фикстуры пакета,
// перестройка индекса настоящим ensureSearchIndex, прогон раннера метрик @actari/search/eval.
// Нужна сборка пакета: pnpm --filter @actari/search build. Запуск: node --test test/search-gold.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { analyzeQuery } from "../vendor/search/index.js";
import { ensureSearchIndex, fillEmbeddings, rankPrecedents } from "../search-index.mjs";

const MCP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const EVAL_INDEX = join(
	MCP_DIR,
	"..",
	"..",
	"packages",
	"search",
	"dist",
	"esm",
	"eval",
	"index.js",
);
const EVAL_FIXTURE = join(
	MCP_DIR,
	"..",
	"..",
	"packages",
	"search",
	"dist",
	"esm",
	"eval",
	"fixture.js",
);

if (!existsSync(EVAL_INDEX)) {
	throw new Error(
		"нет packages/search/dist/esm/eval — собери пакет: pnpm --filter @actari/search build",
	);
}
const { BASELINE, evaluate, loadFixture, loadFixtureVectors, loadGold } = await import(EVAL_INDEX);
const { loadCorpus } = await import(EVAL_FIXTURE);

const SCHEMA_SQL = readFileSync(join(MCP_DIR, "schema.sql"), "utf8");

/** База журнала из корпуса фикстуры; индекс строит настоящая перестройка ensureSearchIndex. */
function buildFixtureDb() {
	const corpus = loadCorpus();
	const dir = mkdtempSync(join(tmpdir(), "actari-gold-"));
	const db = new DatabaseSync(join(dir, "journal.db"));
	db.exec(SCHEMA_SQL);
	db.exec("BEGIN");
	const insTask = db.prepare(
		`INSERT INTO tasks(task_id, project, title, task_text, report_text, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const t of corpus.tasks) {
		insTask.run(
			t.taskId,
			t.project,
			t.title,
			t.taskText,
			t.reportText,
			t.status,
			t.createdAt,
			t.updatedAt ?? t.createdAt,
		);
	}
	const insArt = db.prepare(
		"INSERT INTO artifacts(id, task_id, project, kind, title, body, at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
	);
	for (const a of [...corpus.artifacts].sort((x, y) => x.id - y.id)) {
		insArt.run(a.id, a.project, a.kind, a.title, a.body, a.recordedAt);
	}
	const insInc = db.prepare(
		"INSERT INTO incidents(id, task_id, description, lesson, at) VALUES (?, ?, ?, ?, ?)",
	);
	for (const i of corpus.incidents)
		insInc.run(i.id, i.taskId, i.description, i.lesson, i.recordedAt);
	db.exec("COMMIT");
	// проекты инцидентов в фикстуре известны; в журнале они берутся у задачи или из префикса task_id
	for (const p of new Set(corpus.incidents.map((i) => i.project))) {
		db.prepare("INSERT OR IGNORE INTO projects(name, root_path, at) VALUES (?, ?, ?)").run(
			p,
			`/fixture/${p}`,
			"2026-01-01 00:00:00",
		);
	}
	const started = Date.now();
	const res = ensureSearchIndex(db, { log: () => {} });
	assert.equal(res.rebuilt, true);
	return { db, rebuildMs: Date.now() - started };
}

function fixtureEmbedder() {
	const vectors = loadFixtureVectors();
	const misses = [];
	return {
		misses,
		model: vectors.model,
		async embed(texts) {
			return texts.map((text) => {
				const v = vectors.get(text);
				if (!v) {
					misses.push(text.slice(0, 60));
					return new Float32Array(1024);
				}
				return v;
			});
		},
	};
}

const r2 = (x) => x.toFixed(4);
const line = (name, r) =>
	`${name}: n=${r.n} hit@1=${r2(r.hit1)} hit@5=${r2(r.hit5)} MRR=${r2(r.mrr)} | ` +
	Object.entries(r.byProject)
		.map(([p, s]) => `${p} n=${s.n} MRR=${r2(s.mrr)}`)
		.join(", ");

const FULL_SET = ["dom-pro", "actari", "real", "terms"];
const fx = loadFixture();
const { db, rebuildMs } = buildFixtureDb();

const wordsSearch = async (g) => {
	const { hits } = await rankPrecedents(db, { query: g.q, project: g.project ?? null });
	return hits.map((h) => ({ title: h.title, sourceAt: h.sourceAt }));
};

test("контрольный набор SQLite, слова: MRR на 48 вопросах не ниже 0.76; полный набор лучше базы на 0.10", async () => {
	const g48 = await evaluate(loadGold(), wordsSearch, { now: fx.now });
	const full = await evaluate(loadGold(FULL_SET), wordsSearch, { now: fx.now });
	console.log(`# перестройка индекса фикстуры: ${rebuildMs} мс`);
	console.log(`# слова SQLite, 48: ${line("48", g48)}`);
	console.log(`# слова SQLite, полный набор: ${line("full", full)}`);
	const base = BASELINE.searchPrecedents.full;
	assert.equal(full.n, base.n, "полный набор: 77 вопросов в метриках");
	assert.ok(g48.mrr >= 0.76, `MRR по словам на 48 вопросах ${r2(g48.mrr)} < 0.76`);
	assert.ok(
		full.mrr >= base.mrr + 0.1,
		`полный набор ${r2(full.mrr)} не лучше базы ${base.mrr} на 0.10`,
	);
	for (const r of g48.ranks.filter((x) => x.rank === null)) console.log(`# промах (слова): ${r.q}`);
});

test("контрольный набор SQLite, слова + векторы фикстуры: не ниже облака с векторами минус 0.03, полный набор лучше базы на 0.10", async () => {
	const embedder = fixtureEmbedder();
	await fillEmbeddings(db, embedder, { max: 1_000_000 });
	assert.deepEqual(embedder.misses, [], "у всех фрагментов есть вектор фикстуры");
	const withVectors = async (g) => {
		const { hits } = await rankPrecedents(db, {
			query: g.q,
			project: g.project ?? null,
			embeddings: embedder,
		});
		return hits.map((h) => ({ title: h.title, sourceAt: h.sourceAt }));
	};
	const g48 = await evaluate(loadGold(), withVectors, { now: fx.now });
	const full = await evaluate(loadGold(FULL_SET), withVectors, { now: fx.now });
	console.log(`# слова+векторы SQLite, 48: ${line("48", g48)}`);
	console.log(`# слова+векторы SQLite, полный набор: ${line("full", full)}`);
	console.log(
		`# gold-real, слова+векторы SQLite (ранг): ${full.ranks
			.filter((x) => loadGold(["real"]).some((g) => g.q === x.q))
			.map((x) => `${x.rank ?? "-"} «${x.q}»`)
			.join("; ")}`,
	);
	assert.deepEqual(embedder.misses, [], "у всех вопросов есть вектор фикстуры");
	// Облако с векторами обязано дать ≥ 0.85 на 48 вопросах; локальный — не ниже облачного минус 0.03.
	assert.ok(g48.mrr >= 0.85 - 0.03, `48, с векторами: MRR ${r2(g48.mrr)} < 0.82`);
	assert.ok(g48.mrr > 0.76, `с векторами не хуже слов: ${r2(g48.mrr)}`);
	const base = BASELINE.searchPrecedents.full;
	assert.ok(
		full.mrr >= base.mrr + 0.1,
		`полный набор, с векторами: ${r2(full.mrr)} не лучше базы ${base.mrr} на 0.10`,
	);
});

test("расхождения основ: слова запросов контрольного набора без единого совпадения в индексе проекта", () => {
	const gold = loadGold(["dom-pro", "actari", "real"]);
	let total = 0;
	const dead = [];
	for (const g of gold) {
		if (g.kind === "structured" || !g.project) continue;
		for (const stem of analyzeQuery(g.q)) {
			total++;
			const hit = db
				.prepare(
					`SELECT 1 FROM search_fts JOIN search_chunks c ON c.id = search_fts.rowid
					 WHERE search_fts MATCH ? AND c.project = ? LIMIT 1`,
				)
				.get(`"${stem}"`, g.project);
			if (!hit) dead.push(`${g.project}: «${stem}» ← «${g.q}»`);
		}
	}
	console.log(`# основ запросов: ${total}, без совпадений в индексе проекта: ${dead.length}`);
	for (const d of dead.slice(0, 40)) console.log(`#   ${d}`);
	assert.ok(total > 0);
});

test("«расскажи про стандарт ИЖС»: пул кандидатов не отдаётся длинным разделам — документов стандарта не меньше 5 (слова) и 6 (векторы)", async () => {
	const countIzhs = (hits) => hits.filter((h) => /^ИЖС Стандарт/.test(h.title)).length;
	const byWords = await rankPrecedents(db, {
		query: "расскажи про стандарт ИЖС",
		project: "dom-pro",
	});
	const words = countIzhs(byWords.hits.slice(0, 8));
	const embedder = fixtureEmbedder();
	await fillEmbeddings(db, embedder, { max: 1_000_000 });
	const byVectors = await rankPrecedents(db, {
		query: "расскажи что такое стандарт ИЖС",
		project: "dom-pro",
		embeddings: embedder,
	});
	const vectors = countIzhs(byVectors.hits.slice(0, 8));
	console.log(`# ИЖС (локальный, первые 8): слова ${words}, слова+векторы ${vectors}`);
	assert.ok(words >= 5, `слова: документов стандарта ${words} < 5`);
	assert.ok(vectors >= 6, `векторы: документов стандарта ${vectors} < 6`);
});

const GRID = [];
for (const vector of [1, 2, 3, 4]) for (const words of [0, 0.5, 1]) GRID.push({ vector, words });

test("сетка весов слияния на SQLite: 48 вопросов и полный набор (таблица в вывод)", async () => {
	const embedder = fixtureEmbedder();
	await fillEmbeddings(db, embedder, { max: 1_000_000 });
	const full = loadGold(["dom-pro", "actari", "real", "terms"]);
	const rows = [];
	for (const weights of GRID) {
		const search = async (g) => {
			const { hits } = await rankPrecedents(db, {
				query: g.q,
				project: g.project ?? null,
				embeddings: embedder,
				weights,
			});
			return hits.map((h) => ({ title: h.title, sourceAt: h.sourceAt }));
		};
		const a = await evaluate(loadGold(), search, { now: fx.now });
		const b = await evaluate(full, search, { now: fx.now });
		rows.push(
			`v${weights.vector}/w${weights.words}: 48 h1=${r2(a.hit1)} h5=${r2(a.hit5)} MRR=${r2(a.mrr)} | full h1=${r2(b.hit1)} h5=${r2(b.hit5)} MRR=${r2(b.mrr)}`,
		);
	}
	console.log(`# сетка SQLite (слова + векторы):\n#   ${rows.join("\n#   ")}`);
	const wordsFull = await evaluate(full, wordsSearch, { now: fx.now });
	console.log(`# слова SQLite, полный набор: ${line("full", wordsFull)}`);
	for (const r of wordsFull.ranks.filter((x) => x.rank === null || x.rank > 5))
		console.log(`# промах/ниже 5 (слова, полный): ${r.rank} ${r.q}`);
});
