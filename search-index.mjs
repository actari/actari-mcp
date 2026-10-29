// Локальный поисковый индекс журнала: FTS5 по основам слов пакета @actari/search (вшит в vendor/search),
// фрагменты документов, векторы по явному включению. Индексация — JS в транзакциях записи событий
// (без SQL-триггеров); смена версии индекса перестраивает его НА МЕСТЕ в одной транзакции,
// файл базы не подменяется (инциденты 92, 93, 152).

import {
	ANALYZER_VERSION,
	DEFAULT_FUSION_WEIGHTS,
	analyze,
	analyzeQuery,
	artifactDocKey,
	chunkDocument,
	chunkEmbeddingText,
	collapseByDoc,
	cosineTopK,
	embeddingKey,
	fuse,
	incidentDocKey,
	journalTaskDocKey,
	passageText,
	queryText,
	shouldIndexArtifact,
	snippet,
	versionLabel,
} from "./vendor/search/index.js";

export const SEARCH_INDEX_VERSION = `${ANALYZER_VERSION}.1`;

/** Множитель счёта для проекта текущего каталога. */
export const CURRENT_PROJECT_BOOST = 1.5;
const WORDS_DEPTH = 200;
const VECTOR_DEPTH = 200;
const VECTOR_LIST_DEPTH = 50;
// Не больше стольких фрагментов одного документа в кандидатах списка: иначе длинный документ
// (сотни фрагментов) занимает весь пул и вытесняет остальные документы выдачи.
const CANDIDATES_PER_DOC = 3;
const EMBED_PER_CALL = 64;
const EMBED_BATCH = 16;
const INCIDENT_SNIPPET_LEN = 280;
const INCIDENT_LIMIT = 10;

const SEARCH_DDL = `
CREATE TABLE IF NOT EXISTS search_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS search_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_key     TEXT NOT NULL,
    source_type TEXT NOT NULL,   -- task | artifact | incident
    source_id   TEXT NOT NULL,
    project     TEXT,
    title       TEXT,
    content     TEXT,
    version     INTEGER,
    is_latest   INTEGER NOT NULL DEFAULT 1,
    source_at   TEXT,
    chunk_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_search_chunks_source ON search_chunks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_search_chunks_doc ON search_chunks(doc_key);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title_terms, content_terms,
    content = '', tokenize = 'unicode61 remove_diacritics 0'
);
CREATE TABLE IF NOT EXISTS search_vectors (
    chunk_id      INTEGER PRIMARY KEY,
    embedding_key TEXT NOT NULL,
    vec           BLOB NOT NULL
);
`;

// ============ meta ============

function getMeta(db, key) {
	return db.prepare("SELECT value FROM search_meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(db, key, value) {
	db.prepare(
		"INSERT INTO search_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, String(value));
}

function hasLegacyFts(db) {
	return Boolean(
		db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE name IN ('task_fts','artifact_fts','tasks_fts_insert','tasks_fts_update','artifacts_fts_insert') LIMIT 1",
			)
			.get(),
	);
}

function dropLegacyFts(db) {
	for (const trigger of ["tasks_fts_insert", "tasks_fts_update", "artifacts_fts_insert"]) {
		db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
	}
	for (const table of ["task_fts", "artifact_fts"]) {
		db.exec(`DROP TABLE IF EXISTS ${table}`);
	}
}

// ============ вспомогательное ============

/** SQLite `at` ('YYYY-MM-DD HH:MM:SS', UTC) → ISO-строка. */
function toIso(at) {
	if (!at) return null;
	const text = String(at);
	const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nonBlank(...parts) {
	return parts.filter((p) => typeof p === "string" && p.trim()).join("\n\n");
}

function inTransaction(db, fn) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw err;
	}
}

// ============ запись в индекс ============

function removeSource(db, sourceType, sourceId) {
	const rows = db
		.prepare("SELECT id, title, content FROM search_chunks WHERE source_type = ? AND source_id = ?")
		.all(sourceType, String(sourceId));
	if (rows.length === 0) return;
	const del = db.prepare(
		"INSERT INTO search_fts(search_fts, rowid, title_terms, content_terms) VALUES ('delete', ?, ?, ?)",
	);
	const delVec = db.prepare("DELETE FROM search_vectors WHERE chunk_id = ?");
	const delChunk = db.prepare("DELETE FROM search_chunks WHERE id = ?");
	for (const row of rows) {
		// contentless FTS5: удалить запись можно, только повторив те же термы, что вставляли
		del.run(row.id, analyze(row.title ?? "").join(" "), analyze(row.content ?? "").join(" "));
		delVec.run(row.id);
		delChunk.run(row.id);
	}
}

function insertDoc(db, doc) {
	const chunks = chunkDocument({ title: doc.title ?? "", body: doc.body ?? "" });
	const insChunk = db.prepare(
		`INSERT INTO search_chunks(doc_key, source_type, source_id, project, title, content, version, is_latest, source_at, chunk_index)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insFts = db.prepare(
		"INSERT INTO search_fts(rowid, title_terms, content_terms) VALUES (?, ?, ?)",
	);
	for (const c of chunks) {
		const res = insChunk.run(
			doc.docKey,
			doc.sourceType,
			String(doc.sourceId),
			doc.project ?? null,
			c.title,
			c.text,
			doc.version ?? null,
			doc.isLatest ? 1 : 0,
			doc.sourceAt ?? null,
			c.index,
		);
		insFts.run(Number(res.lastInsertRowid), analyze(c.title).join(" "), analyze(c.text).join(" "));
	}
	return chunks.length;
}

/** tasks: task_id, project, title, task_text, report_text, updated_at. */
export function indexTask(db, row) {
	removeSource(db, "task", row.task_id);
	return insertDoc(db, {
		docKey: journalTaskDocKey(row.task_id),
		sourceType: "task",
		sourceId: row.task_id,
		project: row.project,
		title: row.title,
		body: nonBlank(row.task_text, row.report_text),
		version: null,
		isLatest: true,
		sourceAt: toIso(row.updated_at ?? row.created_at),
	});
}

function insertArtifact(db, row, version, isLatest) {
	return insertDoc(db, {
		docKey: artifactDocKey(row.project, row.title),
		sourceType: "artifact",
		sourceId: row.id,
		project: row.project,
		title: row.title,
		body: row.body,
		version,
		isLatest,
		sourceAt: toIso(row.at),
	});
}

/** artifacts: id, project, kind, title, body, at. Индексируются все версии; служебные заметки — нет. */
export function indexArtifact(db, row) {
	if (!shouldIndexArtifact({ kind: row.kind, title: row.title ?? "" })) return 0;
	removeSource(db, "artifact", row.id);
	const docKey = artifactDocKey(row.project, row.title);
	const version = db
		.prepare("SELECT count(*) AS n FROM artifacts WHERE project = ? AND title = ? AND id <= ?")
		.get(row.project, row.title, row.id).n;
	const maxId = db
		.prepare("SELECT max(id) AS m FROM artifacts WHERE project = ? AND title = ?")
		.get(row.project, row.title).m;
	const isLatest = Number(row.id) === Number(maxId);
	if (isLatest) {
		db.prepare(
			"UPDATE search_chunks SET is_latest = 0 WHERE doc_key = ? AND source_type = 'artifact' AND source_id <> ?",
		).run(docKey, String(row.id));
	}
	return insertArtifact(db, row, version, isLatest);
}

/** Проект инцидента: у записи его нет — берётся у задачи, затем из префикса task_id. */
function projectOfIncident(db, row) {
	if (row.project) return row.project;
	const task = db.prepare("SELECT project FROM tasks WHERE task_id = ?").get(row.task_id);
	if (task?.project) return task.project;
	const prefix = String(row.task_id ?? "").split("/")[0];
	if (prefix && db.prepare("SELECT 1 FROM projects WHERE name = ?").get(prefix)) return prefix;
	return null;
}

function incidentTitle(id, description) {
	const first = String(description ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return `Инцидент ${id}: ${first}`;
}

/** incidents: id, task_id, description, lesson, at (+ необязательный project). */
export function indexIncident(db, row) {
	removeSource(db, "incident", row.id);
	return insertDoc(db, {
		docKey: incidentDocKey(row.id),
		sourceType: "incident",
		sourceId: row.id,
		project: projectOfIncident(db, row),
		title: incidentTitle(row.id, row.description),
		body: nonBlank(row.description, row.lesson),
		version: null,
		isLatest: true,
		sourceAt: toIso(row.at),
	});
}

// ============ перестройка и догон ============

function currentMarks(db) {
	return {
		seq: db.prepare("SELECT coalesce(max(seq), 0) AS m FROM events").get().m,
		artifactId: db.prepare("SELECT coalesce(max(id), 0) AS m FROM artifacts").get().m,
		incidentId: db.prepare("SELECT coalesce(max(id), 0) AS m FROM incidents").get().m,
	};
}

function saveMarks(db, marks) {
	setMeta(db, "indexed_seq", marks.seq);
	setMeta(db, "indexed_artifact_id", marks.artifactId);
	setMeta(db, "indexed_incident_id", marks.incidentId);
}

function rebuildAll(db) {
	db.exec("INSERT INTO search_fts(search_fts) VALUES ('delete-all')");
	db.exec("DELETE FROM search_vectors");
	db.exec("DELETE FROM search_chunks");
	const marks = currentMarks(db);
	let tasks = 0;
	for (const row of db.prepare("SELECT * FROM tasks ORDER BY rowid").all()) {
		indexTask(db, row);
		tasks++;
	}
	// версии и «последняя» считаются заранее: перестройка не должна быть квадратичной
	const counters = new Map();
	const latest = new Map();
	const artifacts = db.prepare("SELECT * FROM artifacts ORDER BY id").all();
	for (const a of artifacts) latest.set(artifactDocKey(a.project, a.title), a.id);
	let artifactCount = 0;
	for (const a of artifacts) {
		const key = artifactDocKey(a.project, a.title);
		const version = (counters.get(key) ?? 0) + 1;
		counters.set(key, version);
		if (!shouldIndexArtifact({ kind: a.kind, title: a.title ?? "" })) continue;
		insertArtifact(db, a, version, latest.get(key) === a.id);
		artifactCount++;
	}
	let incidents = 0;
	for (const row of db.prepare("SELECT * FROM incidents ORDER BY id").all()) {
		indexIncident(db, row);
		incidents++;
	}
	saveMarks(db, marks);
	setMeta(db, "index_version", SEARCH_INDEX_VERSION);
	return { tasks, artifacts: artifactCount, incidents };
}

/**
 * Индексирует всё, что записано после последней метки (в том числе события, которые записала
 * другая — например, старая — версия сервера). Вызывать внутри транзакции записи.
 */
export function indexPending(db) {
	const had = {
		seq: Number(getMeta(db, "indexed_seq") ?? 0),
		artifactId: Number(getMeta(db, "indexed_artifact_id") ?? 0),
		incidentId: Number(getMeta(db, "indexed_incident_id") ?? 0),
	};
	const now = currentMarks(db);
	if (
		now.seq === had.seq &&
		now.artifactId === had.artifactId &&
		now.incidentId === had.incidentId
	) {
		return 0;
	}
	let n = 0;
	const touched = db
		.prepare(
			"SELECT DISTINCT task_id FROM events WHERE seq > ? AND type IN ('TaskDrafted', 'ReportSubmitted')",
		)
		.all(had.seq);
	for (const { task_id } of touched) {
		const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(task_id);
		if (row) {
			indexTask(db, row);
			n++;
		}
	}
	for (const row of db
		.prepare("SELECT * FROM artifacts WHERE id > ? ORDER BY id")
		.all(had.artifactId)) {
		indexArtifact(db, row);
		n++;
	}
	for (const row of db
		.prepare("SELECT * FROM incidents WHERE id > ? ORDER BY id")
		.all(had.incidentId)) {
		indexIncident(db, row);
		n++;
	}
	saveMarks(db, now);
	return n;
}

/** Есть ли что догонять (без записи). */
export function hasPendingIndex(db) {
	const now = currentMarks(db);
	return (
		now.seq !== Number(getMeta(db, "indexed_seq") ?? 0) ||
		now.artifactId !== Number(getMeta(db, "indexed_artifact_id") ?? 0) ||
		now.incidentId !== Number(getMeta(db, "indexed_incident_id") ?? 0)
	);
}

/**
 * Создаёт таблицы индекса; при несовпадении версии (или остатках старых task_fts/artifact_fts)
 * перестраивает индекс на месте в одной транзакции — файл базы остаётся тем же.
 */
export function ensureSearchIndex(db, { log = (line) => console.error(line) } = {}) {
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(SEARCH_DDL);
	const upToDate = () => getMeta(db, "index_version") === SEARCH_INDEX_VERSION && !hasLegacyFts(db);
	if (upToDate()) {
		if (hasPendingIndex(db)) inTransaction(db, () => indexPending(db));
		return { rebuilt: false };
	}
	const started = Date.now();
	let before = null;
	let counts = null;
	let legacy = false;
	const rebuilt = inTransaction(db, () => {
		// пока ждали блокировку, другой процесс мог уже перестроить индекс
		if (upToDate()) return false;
		before = getMeta(db, "index_version");
		legacy = hasLegacyFts(db);
		dropLegacyFts(db);
		counts = rebuildAll(db);
		return true;
	});
	// на пустой новой базе молчим: шум в stderr без повода
	const empty = counts && counts.tasks + counts.artifacts + counts.incidents === 0;
	if (rebuilt && !(empty && before === null && !legacy)) {
		log(
			`actari: индекс поиска перестроен на месте (версия ${before ?? "—"} → ${SEARCH_INDEX_VERSION}): ` +
				`задач ${counts.tasks}, артефактов ${counts.artifacts}, инцидентов ${counts.incidents}, ${Date.now() - started} мс`,
		);
	}
	return { rebuilt };
}

// ============ эмбеддинги ============

/** ACTARI_SEARCH_EMBEDDINGS=on + OPENAI_EMBEDDING_BASE_URL/MODEL (+ KEY, KEY_HEADER). Одних переменных мало. */
export function embeddingsConfig(env = process.env) {
	const flag = String(env.ACTARI_SEARCH_EMBEDDINGS ?? "")
		.trim()
		.toLowerCase();
	const baseUrl = env.OPENAI_EMBEDDING_BASE_URL?.trim() || null;
	const model = env.OPENAI_EMBEDDING_MODEL?.trim() || null;
	const configured = Boolean(baseUrl && model);
	const base = {
		enabled: false,
		model: null,
		baseUrl: null,
		apiKey: null,
		apiKeyHeader: null,
	};
	if (flag !== "on") {
		return {
			...base,
			reason: configured
				? "векторы выключены: тексты журнала уйдут в сервис эмбеддингов только при ACTARI_SEARCH_EMBEDDINGS=on"
				: "",
		};
	}
	if (!configured) {
		return {
			...base,
			reason:
				"ACTARI_SEARCH_EMBEDDINGS=on, но не заданы OPENAI_EMBEDDING_BASE_URL и OPENAI_EMBEDDING_MODEL — только слова",
		};
	}
	return {
		enabled: true,
		model,
		baseUrl,
		apiKey: env.OPENAI_EMBEDDING_API_KEY?.trim() || null,
		apiKeyHeader: env.OPENAI_EMBEDDING_API_KEY_HEADER?.trim() || null,
		reason: "",
	};
}

export function searchModeLine(cfg) {
	if (!cfg?.enabled) return "поиск: слова";
	let host = cfg.baseUrl;
	try {
		host = new URL(cfg.baseUrl).host;
	} catch {}
	return `поиск: слова + векторы (${host}, ${cfg.model})`;
}

/** Эмбеддер по конфигу; не включено — null (сеть не трогается). */
export function createEmbedder(cfg, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
	if (!cfg?.enabled) return null;
	const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
	const headers = { "content-type": "application/json" };
	if (cfg.apiKey) {
		if (cfg.apiKeyHeader) headers[cfg.apiKeyHeader] = cfg.apiKey;
		else headers.authorization = `Bearer ${cfg.apiKey}`;
	}
	async function post(texts) {
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: cfg.model, input: texts }),
			signal: AbortSignal.timeout(30000),
		});
		if (res.status === 413 && texts.length > 1) {
			const mid = Math.ceil(texts.length / 2);
			return [...(await post(texts.slice(0, mid))), ...(await post(texts.slice(mid)))];
		}
		if (!res.ok) throw new Error(`сервис эмбеддингов ответил HTTP ${res.status}`);
		const json = await res.json();
		const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		if (data.length !== texts.length) throw new Error("сервис эмбеддингов вернул не все векторы");
		return data.map((d) => Float32Array.from(d.embedding));
	}
	return {
		model: cfg.model,
		async embed(texts) {
			const out = [];
			for (let i = 0; i < texts.length; i += EMBED_BATCH) {
				out.push(...(await post(texts.slice(i, i + EMBED_BATCH))));
			}
			return out;
		},
	};
}

function vecToBlob(vec) {
	const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
	return new Uint8Array(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength));
}

function blobToVec(blob) {
	const copy = new Uint8Array(blob).buffer;
	return new Float32Array(copy);
}

/** Досчитывает векторы недостающим фрагментам (не более `max`), приоритет — `preferIds`, затем свежие. */
export async function fillEmbeddings(
	db,
	embedder,
	{ max = EMBED_PER_CALL, project, preferIds = [] } = {},
) {
	const key = embeddingKey(embedder.model);
	const rows = db
		.prepare(
			`SELECT c.id, c.title, c.content FROM search_chunks c
			 LEFT JOIN search_vectors v ON v.chunk_id = c.id AND v.embedding_key = ?
			 WHERE v.chunk_id IS NULL ${project ? "AND c.project = ?" : ""}
			 ORDER BY (c.id IN (SELECT value FROM json_each(?))) DESC, c.source_at DESC, c.id
			 LIMIT ?`,
		)
		.all(...[key, ...(project ? [project] : []), JSON.stringify(preferIds), max]);
	if (rows.length === 0) return 0;
	const texts = rows.map((r) =>
		passageText(
			embedder.model,
			chunkEmbeddingText({ title: r.title ?? "", text: r.content ?? "" }),
		),
	);
	const vectors = await embedder.embed(texts);
	const ins = db.prepare(
		"INSERT OR REPLACE INTO search_vectors(chunk_id, embedding_key, vec) VALUES (?, ?, ?)",
	);
	inTransaction(db, () => {
		for (const [i, row] of rows.entries()) {
			// фрагмент мог быть переиндексирован, пока шёл запрос в сервис
			if (db.prepare("SELECT 1 FROM search_chunks WHERE id = ?").get(row.id)) {
				ins.run(row.id, key, vecToBlob(vectors[i]));
			}
		}
	});
	return rows.length;
}

export function missingEmbeddingsCount(db, embedder) {
	return db
		.prepare(
			`SELECT count(*) AS n FROM search_chunks c
			 LEFT JOIN search_vectors v ON v.chunk_id = c.id AND v.embedding_key = ?
			 WHERE v.chunk_id IS NULL`,
		)
		.get(embeddingKey(embedder.model)).n;
}

// ============ поиск ============

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Слова текста, чьи основы есть в запросе, берутся в [скобки] — как подсвечивал snippet() FTS5. */
export function highlight(text, stems) {
	if (!text || stems.length === 0) return text ?? "";
	const set = new Set(stems);
	return text.replace(WORD_RE, (w) => (analyze(w).some((s) => set.has(s)) ? `[${w}]` : w));
}

function ftsExpr(stems) {
	return stems.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

function wordsHits(db, stems, project) {
	if (stems.length === 0) return [];
	return db
		.prepare(
			`SELECT * FROM (
			   SELECT *, ROW_NUMBER() OVER (PARTITION BY doc_key ORDER BY s, chunk_id) AS rn FROM (
			     SELECT c.id AS chunk_id, c.doc_key, c.source_type, c.source_id, c.project, c.title,
			            c.version, c.is_latest, c.source_at, bm25(search_fts, 4.0, 1.0) AS s
			     FROM search_fts JOIN search_chunks c ON c.id = search_fts.rowid
			     WHERE search_fts MATCH ? ${project ? "AND c.project = ?" : ""}
			   )
			 ) WHERE rn <= ? ORDER BY s LIMIT ?`,
		)
		.all(...[ftsExpr(stems), ...(project ? [project] : []), CANDIDATES_PER_DOC, WORDS_DEPTH])
		.map((r) => toHit(r, -r.s));
}

function toHit(r, score) {
	return {
		chunkId: r.chunk_id ?? r.id,
		docKey: r.doc_key,
		sourceType: r.source_type,
		sourceId: r.source_id,
		project: r.project,
		title: r.title,
		version: r.version,
		isLatest: Boolean(r.is_latest),
		sourceAt: r.source_at ? new Date(r.source_at) : null,
		score,
	};
}

function vectorHits(db, queryVec, key, project) {
	const rows = db
		.prepare(
			`SELECT c.id AS chunk_id, c.doc_key, c.source_type, c.source_id, c.project, c.title,
			        c.version, c.is_latest, c.source_at, v.vec
			 FROM search_vectors v JOIN search_chunks c ON c.id = v.chunk_id
			 WHERE v.embedding_key = ? ${project ? "AND c.project = ?" : ""}`,
		)
		.all(...[key, ...(project ? [project] : [])]);
	const byId = new Map(rows.map((r) => [String(r.chunk_id), r]));
	const ranked = cosineTopK(
		queryVec,
		rows.map((r) => ({ id: String(r.chunk_id), vec: blobToVec(r.vec) })),
		rows.length,
	);
	// Не больше CANDIDATES_PER_DOC фрагментов на документ, затем глубина списка.
	const perDoc = new Map();
	const top = [];
	for (const t of ranked) {
		const docKey = byId.get(t.id).doc_key;
		const n = perDoc.get(docKey) ?? 0;
		if (n >= CANDIDATES_PER_DOC) continue;
		perDoc.set(docKey, n + 1);
		top.push(t);
		if (top.length >= VECTOR_DEPTH) break;
	}
	return top.map((t) => toHit(byId.get(t.id), t.score));
}

/**
 * Ранжированные документы (задачи, артефакты, инциденты вперемешку): слова, при наличии эмбеддера —
 * векторы и слияние `fuse`; один документ — одна запись (`collapseByDoc`); проект текущего каталога ×1.5.
 */
export async function rankPrecedents(
	db,
	{
		query,
		project = null,
		currentProject = null,
		embeddings = null,
		weights = DEFAULT_FUSION_WEIGHTS,
		log = () => {},
	},
) {
	if (hasPendingIndex(db)) inTransaction(db, () => indexPending(db));
	const stems = analyzeQuery(query ?? "");
	const words = collapseByDoc(wordsHits(db, stems, project));
	let ranked = words;
	let vectorUsed = false;
	if (embeddings && stems.length + String(query ?? "").trim().length > 0) {
		try {
			await fillEmbeddings(db, embeddings, {
				project,
				preferIds: words.slice(0, 40).map((h) => h.chunkId),
			});
			const [queryVec] = await embeddings.embed([queryText(embeddings.model, query)]);
			const vec = collapseByDoc(
				vectorHits(db, queryVec, embeddingKey(embeddings.model), project),
			).slice(0, VECTOR_LIST_DEPTH);
			if (vec.length > 0) {
				const byKey = new Map([...words, ...vec].map((h) => [h.docKey, h]));
				ranked = fuse(
					[
						{ name: "words", items: words.map((h) => h.docKey) },
						{ name: "vector", items: vec.map((h) => h.docKey) },
					],
					{ key: (k) => k, weights },
				).map((f) => ({ ...byKey.get(f.item), score: f.score }));
				vectorUsed = true;
			}
		} catch (err) {
			log(`actari: векторы поиска недоступны, ответ по словам: ${err.message}`);
		}
	}
	if (currentProject) {
		ranked = ranked
			.map((h, i) => ({
				h: h.project === currentProject ? { ...h, score: h.score * CURRENT_PROJECT_BOOST } : h,
				i,
			}))
			.sort((a, b) => b.h.score - a.h.score || a.i - b.i)
			.map(({ h }) => h);
	}
	return { hits: ranked, stems, vectorUsed };
}

function compactText(text) {
	if (text == null) return text;
	return text.length > INCIDENT_SNIPPET_LEN ? `${text.slice(0, INCIDENT_SNIPPET_LEN)}…` : text;
}

/** Формат ответа совместим с прежним search_precedents; новые поля — только добавлением. */
export async function searchPrecedents(
	db,
	{
		query,
		project = null,
		limit = 5,
		full = false,
		currentProject = null,
		embeddings = null,
		log = () => {},
	},
) {
	const { hits, stems } = await rankPrecedents(db, {
		query,
		project,
		currentProject,
		embeddings,
		log,
	});
	const tasks = [];
	const artifacts = [];
	const incidents = [];
	const chunkText = db.prepare("SELECT content FROM search_chunks WHERE id = ?");
	for (const h of hits) {
		if (h.sourceType === "task" && tasks.length < limit) {
			const t = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(h.sourceId);
			if (!t) continue;
			tasks.push({
				task_id: t.task_id,
				project: t.project,
				title: t.title,
				status: t.status,
				outcome: t.outcome,
				evidence: t.evidence,
				task_snippet: highlight(snippet(t.task_text ?? "", stems), stems),
				report_snippet: highlight(snippet(t.report_text ?? "", stems), stems),
			});
		} else if (h.sourceType === "artifact" && artifacts.length < limit) {
			const a = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(Number(h.sourceId));
			if (!a) continue;
			const content = chunkText.get(h.chunkId)?.content ?? a.body ?? "";
			const entry = {
				id: a.id,
				project: a.project,
				kind: a.kind,
				title: a.title,
				task_id: a.task_id,
				at: a.at,
				body_snippet: highlight(snippet(content, stems), stems),
			};
			if (!h.isLatest && h.sourceAt) entry.version_label = versionLabel(h.sourceAt);
			artifacts.push(entry);
		} else if (h.sourceType === "incident" && incidents.length < INCIDENT_LIMIT) {
			const i = db
				.prepare("SELECT id, task_id, description, lesson, at FROM incidents WHERE id = ?")
				.get(Number(h.sourceId));
			if (!i) continue;
			incidents.push(
				full
					? i
					: {
							id: i.id,
							task_id: i.task_id,
							at: i.at,
							description: compactText(i.description),
							lesson: compactText(i.lesson),
							description_length: i.description?.length ?? 0,
							lesson_length: i.lesson?.length ?? 0,
						},
			);
		}
	}
	return { tasks, artifacts, incidents };
}
