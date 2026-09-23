#!/usr/bin/env node
// actari — MCP-сервер журнала задач для AI-агентов.
// Хранилище: ~/.actari/journal.db (event sourcing: append-only events,
// проекции tasks/incidents через триггеры, FTS5); путь перекрывается
// ACTARI_DB — см. resolveDbPath в sync.mjs.
// Zero deps: node:sqlite (Node >= 22.5).

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readEnv } from "./env.mjs";
import {
	defaultJournalId,
	fetchCursor,
	inboxUrlFromBase,
	loadSyncConfig,
	loadSyncTargets,
	normalizeBaseUrl,
	parseWorkspaces,
	policyUrlFromBase,
	pushJournal,
	readSyncConfigFile,
	resolveCloudUrl,
	resolveDbPath,
	resolveSyncScope,
	syncUrlFromBase,
	targetAlias,
	writeSyncConfig,
} from "./sync.mjs";
import {
	applyWorkspacePolicies,
	fetchWorkspacePolicies,
	normalizePolicyBody,
	pickStartupPolicy,
	readPolicyFile,
	renderArtifactTitle,
	renderToolDescription,
	resolvePolicy,
	validatePolicyBody,
	writePolicyFile,
} from "./policy.mjs";
import {
	CHANGES_PAGE,
	INTENT_CACHE_DDL,
	INTENT_POLL_MS,
	INTENT_TIMEOUT_MS,
	UNSUPPORTED_NOTICE,
	decideIntentGate,
	describeIntentChange,
	fetchIntent,
	fetchIntentChanges,
	formatInboxItem,
	formatIntentStatus,
	formatNotices,
	formatReleaseRejection,
	formatSyncWarning,
	formatTakeContext,
	formatTakeRejection,
	formatWhen,
	parseJournalAt,
	postIntentRelease,
	readIntentCache,
	readIntentMeta,
	seenOf,
	writeIntentMeta,
	writeIntentView,
} from "./intent.mjs";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

// Версия — единственный источник правды package.json: продублированная в коде
// строка неминуемо разъезжается с опубликованной.
const PACKAGE_VERSION = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version;

const DB_PATH = resolveDbPath();
const SCHEMA_PATH = readEnv("SCHEMA") ?? join(PACKAGE_DIR, "schema.sql");

// Чистый старт на пустой машине: директория данных создаётся сама,
// иначе node:sqlite падает CANTOPEN ещё до применения схемы.
mkdirSync(dirname(DB_PATH), { recursive: true });

function requireSchemaFile() {
	if (!existsSync(SCHEMA_PATH)) {
		console.error(`actari: схема не найдена: ${SCHEMA_PATH}`);
		process.exit(1);
	}
	return readFileSync(SCHEMA_PATH, "utf8");
}

// ============ перенос старой схемы переигрыванием ============
// Вся база — проекции из events (tasks, projects, artifacts, incidents,
// task_links собираются триггерами). Смена схемы проекций — не миграция, а
// новая база + повтор событий по seq. Старый файл остаётся рядом бэкапом.

function tasksHaveEvidenceColumn(database) {
	return database
		.prepare("PRAGMA table_info(tasks)")
		.all()
		.some((col) => col.name === "evidence");
}

// payload события старой схемы → новой: Accepted нёс verify_commit
function migratePayload(type, payloadJson) {
	if (type !== "Accepted") return payloadJson;
	const payload = JSON.parse(payloadJson);
	if ("verify_commit" in payload) {
		payload.evidence = payload.verify_commit;
		delete payload.verify_commit;
	}
	return JSON.stringify(payload);
}

function replayJournal(dbPath, oldDb) {
	// WAL сливается в основной файл до переименования — иначе хвост уедет в бэкап
	oldDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	const events = oldDb
		.prepare("SELECT seq, task_id, type, payload, at FROM events ORDER BY seq")
		.all();
	oldDb.close();

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = `${dbPath}.${stamp}.bak`;
	renameSync(dbPath, backup);
	for (const suffix of ["-wal", "-shm"]) {
		if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
	}

	const fresh = new DatabaseSync(dbPath);
	fresh.exec(requireSchemaFile());
	// seq и at сохраняются: курсоры синка и хронология — часть журнала
	const insert = fresh.prepare(
		"INSERT INTO events(seq, task_id, type, payload, at) VALUES (?, ?, ?, ?, ?)",
	);
	fresh.exec("BEGIN");
	for (const e of events) {
		insert.run(e.seq, e.task_id, e.type, migratePayload(e.type, e.payload), e.at);
	}
	fresh.exec("COMMIT");
	console.error(
		`actari: схема журнала обновлена — перенесено ${events.length} событий, бэкап: ${backup}`,
	);
	return fresh;
}

let db = new DatabaseSync(DB_PATH);
const hasEvents = db
	.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
	.get();
if (!hasEvents) {
	db.exec(requireSchemaFile());
} else if (!tasksHaveEvidenceColumn(db)) {
	db = replayJournal(DB_PATH, db);
}

// Служебные таблицы кэша намерений (спека 2026-09-14 §9.1) — не события.
db.exec(INTENT_CACHE_DDL);

// Допустимые переходы: событие → из каких статусов его можно применить.
const VALID_FROM = {
	Delegated: ["DRAFT", "REWORK"],
	ReportSubmitted: ["DELEGATED"],
	Accepted: ["REPORTED"],
	ReworkRequested: ["REPORTED"],
	Failed: ["DELEGATED", "REPORTED", "REWORK"],
};

const getTaskStmt = db.prepare("SELECT * FROM tasks WHERE task_id = ?");
const insertEventStmt = db.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)");

// Авто-пуш синка: fire-and-forget после успешной записи события. НИКОГДА не
// блокирует и не роняет запись: нет конфига — молчаливый no-op, ошибка/офлайн —
// одна строка в stderr (курсор просто отстаёт до следующего пуша).
let syncInFlight = false;
let syncQueued = false;
function scheduleAutoPush() {
	if (syncInFlight) {
		syncQueued = true;
		return;
	}
	syncInFlight = true;
	setImmediate(async () => {
		try {
			const targets = loadSyncTargets({ dbPath: DB_PATH });
			if (targets.length > 0) {
				// Цели независимы: ошибка одной — строка в stderr, остальные едут.
				const result = await pushJournal({ dbPath: DB_PATH, targets });
				for (const target of result.targets) {
					for (const warning of target.warnings ?? []) pushNotice(syncWarningText(warning));
					if (!target.error) continue;
					const where = targets.length > 1 ? ` (${target.alias})` : "";
					console.error(`actari: авто-пуш синка не прошёл${where}: ${target.error}`);
				}
			}
		} catch (err) {
			console.error(`actari: авто-пуш синка не прошёл: ${err.message}`);
		} finally {
			syncInFlight = false;
			if (syncQueued) {
				syncQueued = false;
				scheduleAutoPush();
			}
		}
	});
}

// Общая точка записи события: вставка + авто-пуш (только после успешной вставки).
function appendEvent(taskId, type, payloadJson) {
	insertEventStmt.run(taskId, type, payloadJson);
	scheduleAutoPush();
}

// Переход допустим из текущего статуса? Возвращает строку задачи.
function assertTransition(taskId, type) {
	const guard = VALID_FROM[type];
	const task = getTaskStmt.get(taskId);
	if (!guard) return task;
	if (!task) throw new Error(`Задача ${taskId} не найдена`);
	if (!guard.includes(task.status)) {
		throw new Error(
			`${type} недопустим из статуса ${task.status} (допустимо из: ${guard.join(", ")})`,
		);
	}
	return task;
}

function emit(taskId, type, payload) {
	assertTransition(taskId, type);
	appendEvent(taskId, type, JSON.stringify(payload ?? {}));
	return compactTask(getTaskStmt.get(taskId));
}

// Компактный вид строки задачи: без задания и отчёта, с их длинами.
// has_report сохраняет проверку «отчёт записался» (инцидент 2026-09-01).
function compactTask(task) {
	const { task_text, report_text, ...rest } = task;
	return {
		...rest,
		task_text_length: task_text?.length ?? 0,
		report_length: report_text?.length ?? 0,
		has_report: Boolean(report_text),
	};
}

const INCIDENT_SNIPPET_LEN = 280;

function truncateField(text) {
	if (text == null) return text;
	return text.length > INCIDENT_SNIPPET_LEN ? `${text.slice(0, INCIDENT_SNIPPET_LEN)}…` : text;
}

// Компактный вид инцидента: description/lesson обрезаны до 280 символов
// (в живом журнале — до 2 КБ каждый, см. диагноз T6), с их длинами.
function compactIncident(incident) {
	const { description, lesson, ...rest } = incident;
	return {
		...rest,
		description: truncateField(description),
		lesson: truncateField(lesson),
		description_length: description?.length ?? 0,
		lesson_length: lesson?.length ?? 0,
	};
}

// ============ намерения облака (спека 2026-09-14 §9) ============

const INTENT_TIMEOUT = Number(readEnv("INTENT_TIMEOUT_MS")) || INTENT_TIMEOUT_MS;
const INBOX_TIMEOUT = Number(readEnv("INBOX_TIMEOUT_MS")) || 10_000;
const INTENT_POLL = Number(readEnv("INTENT_POLL_MS")) || INTENT_POLL_MS;

// Уведомления для агента приклеиваются к ответу следующего инструмента
// (диспетчер tools/call) и очищаются: протолкнуть сообщение в разговор MCP
// не может, а ответ инструмента агент видит всегда.
const pendingNotices = [];

function pushNotice(line) {
	if (line && !pendingNotices.includes(line)) pendingNotices.push(line);
}

function drainNotices() {
	return pendingNotices.splice(0, pendingNotices.length);
}

// Уведомления — отдельным блоком content: результат инструмента часто JSON,
// и приклеенный к нему текст сломал бы разбор у любого клиента.
function contentWithNotices(text) {
	const lines = drainNotices();
	const content = [{ type: "text", text }];
	if (lines.length > 0) content.push({ type: "text", text: formatNotices(lines) });
	return content;
}

// В облаке нет маршрута намерений (старая версия) — проверки до перезапуска выключены.
let intentsUnsupported = false;

function markIntentsUnsupported() {
	if (!intentsUnsupported) pushNotice(UNSUPPORTED_NOTICE);
	intentsUnsupported = true;
}

function usableTargets() {
	return loadSyncTargets({ dbPath: DB_PATH, log: () => {} }).filter(
		(target) => target.url && target.token,
	);
}

// Цели в порядке вероятности: сначала та, откуда намерение уже приходило.
function orderedTargets(preferredUrl) {
	const targets = usableTargets();
	if (!preferredUrl) return targets;
	return [
		...targets.filter((target) => target.url === preferredUrl),
		...targets.filter((target) => target.url !== preferredUrl),
	];
}

// intent_task_id журнальной задачи — из последнего TaskDrafted (redraft может сменить).
function intentOfJournalTask(taskId) {
	const row = db
		.prepare(
			"SELECT json_extract(payload, '$.intent_task_id') AS intent FROM events WHERE task_id = ? AND type = 'TaskDrafted' ORDER BY seq DESC LIMIT 1",
		)
		.get(taskId);
	return typeof row?.intent === "string" && row.intent ? row.intent : null;
}

// Состояние намерения: облако, иначе кэш. offline — синк не настроен (журнал
// живёт локально, проверять не у кого); unsupported — старое облако.
async function lookupIntent(intentTaskId) {
	const cached = readIntentCache(db, intentTaskId);
	if (intentsUnsupported) return { view: null, cached, unsupported: true };
	const targets = orderedTargets(cached?.target_url);
	if (targets.length === 0) return { view: null, cached, offline: true };
	let unavailable = null;
	for (const target of targets) {
		const result = await fetchIntent({ target, intentTaskId, timeoutMs: INTENT_TIMEOUT });
		if (result.kind === "ok") return { view: result.view, cached, target };
		if (result.kind === "unsupported") {
			markIntentsUnsupported();
			return { view: null, cached, unsupported: true };
		}
		if (result.kind === "unavailable") unavailable = result.error;
	}
	if (unavailable) return { view: cached?.view ?? null, cached, unavailable };
	return { view: null, cached, missing: true };
}

// Проверка перед записью события (спека §9.2). Отказ — исключение с текстом,
// событие не пишется. Возвращает состояние, по которому решали (или null).
async function checkIntentGate(act, intentTaskId, localCreatedAt = null, extra = {}) {
	if (!intentTaskId) return null;
	const found = await lookupIntent(intentTaskId);
	if (found.unsupported || found.offline) return null;
	if (found.missing) {
		pushNotice(
			`намерение ${intentTaskId} не найдено в облаке (удалено или чужое) — проверка состояния пропущена`,
		);
		return null;
	}
	if (found.unavailable) {
		pushNotice(
			found.view
				? `состояние намерения ${intentTaskId} не проверено: облако недоступно (${found.unavailable}) — решение по кэшу на ${formatWhen(found.cached.fetched_at)}`
				: `состояние намерения ${intentTaskId} не проверено: облако недоступно (${found.unavailable}), кэша нет — пропускаю`,
		);
		if (!found.view) return null;
	}
	const decision = decideIntentGate({
		act,
		view: found.view,
		seen: found.cached
			? seenOf(found.cached)
			: { criteriaVersion: 0, criteria: null, priority: found.view?.priority ?? null },
		localCreatedAt,
		seenReopenedAt: extra.seenReopenedAt ?? null,
		localStatus: extra.localStatus ?? null,
	});
	if (found.target) {
		writeIntentView(db, { targetUrl: found.target.url, view: found.view, markSeen: false });
	}
	for (const notice of decision.notices) pushNotice(notice);
	if (decision.block) throw new Error(decision.block);
	return { view: found.view, fromCloud: Boolean(found.target) };
}

// reopenedAt облака, увиденный при заведении черновика: пара задача журнала +
// намерение (redraft может сменить намерение). Служебная таблица, не событие.
function draftReopenedKey(taskId, intentTaskId) {
	return `draft_reopened:${taskId}:${intentTaskId}`;
}

// Акт над задачей: переход допустим → намерение позволяет → событие.
async function emitWithIntentGate(taskId, type, act, payload) {
	const task = assertTransition(taskId, type);
	const intentTaskId = intentOfJournalTask(taskId);
	await checkIntentGate(act, intentTaskId, parseJournalAt(task.created_at), {
		seenReopenedAt: intentTaskId
			? readIntentMeta(db, draftReopenedKey(taskId, intentTaskId))
			: null,
		localStatus: task.status,
	});
	return emit(taskId, type, payload);
}

// Проект журнала должен вести в пространство намерения, иначе события не
// доедут до его доски (спека §9.3).
async function checkProjectBinding(projectRow, view) {
	if (!view?.workspace?.id) return;
	const bound = projectRow.cloud_workspace_id || null;
	if (bound === view.workspace.id) return;
	const bind = `sync_scope { workspace: "${view.workspace.slug}", projects: ["${projectRow.name}"] }`;
	if (bound) {
		throw new Error(
			`проект «${projectRow.name}» привязан к другому пространству (${bound}), а намерение ${view.id} — из пространства ${view.workspace.slug}: события не доедут до его доски. Заведи задачу в проекте этого пространства или перепривяжи: ${bind}.`,
		);
	}
	const [target] = orderedTargets(readIntentCache(db, view.id)?.target_url);
	const cursor = target
		? await fetchCursor({ config: target, timeoutMs: INTENT_TIMEOUT })
		: { error: "синк не настроен" };
	if (Array.isArray(cursor.workspaces) && cursor.workspaces.length > 1) {
		throw new Error(
			`проект «${projectRow.name}» не привязан к пространству, а пространств у токена несколько — журнал этого проекта никуда не уедет. Привяжи: ${bind}.`,
		);
	}
	pushNotice(
		cursor.error
			? `проект «${projectRow.name}» не привязан к пространству ${view.workspace.slug}, число пространств проверить не удалось (${cursor.error}) — привязать: ${bind}`
			: `проект «${projectRow.name}» не привязан к пространству — пока пространство одно, журнал уедет в ${view.workspace.slug}; привязать явно: ${bind}`,
	);
}

// Сводка намерения для get_task: без отказов, только факт.
async function summarizeIntent(intentTaskId) {
	const found = await lookupIntent(intentTaskId);
	if (!found.view) {
		const source = found.unsupported
			? "unsupported"
			: found.offline
				? "offline"
				: found.missing
					? "missing"
					: "unavailable";
		return { intent_task_id: intentTaskId, state: null, source };
	}
	if (found.target) {
		writeIntentView(db, { targetUrl: found.target.url, view: found.view, markSeen: false });
	}
	return {
		intent_task_id: intentTaskId,
		state: found.view.derived?.state ?? null,
		override: found.view.override?.kind ?? null,
		is_mine: Boolean(found.view.isMine),
		criteria_version: found.view.criteriaVersion,
		source: found.target ? "cloud" : "cache",
	};
}

// Проекты локального реестра, привязанные к пространству.
function projectsOfWorkspace(workspaceId) {
	if (!workspaceId) return [];
	return db
		.prepare("SELECT name FROM projects WHERE cloud_workspace_id = ? ORDER BY name")
		.all(workspaceId)
		.map((row) => row.name);
}

function syncWarningText(warning) {
	const row = db.prepare("SELECT task_id FROM events WHERE seq = ?").get(warning.seq);
	return formatSyncWarning(warning, row?.task_id ?? null);
}

// Префиксный матч каждого токена: русская морфология без стеммера —
// «стандарт» находит «стандарты/стандартов», «ранг» — «ранги».
function ftsExpr(query) {
	return query
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => `"${t.replaceAll('"', '""')}"*`)
		.join(" OR ");
}

const getProjectStmt = db.prepare("SELECT * FROM projects WHERE name = ?");

// Нормализация имени проекта для поиска почти-дублей: dompro ~ dom-pro ~ DomPro
function normalizeProjectName(name) {
	return name.toLowerCase().replaceAll("-", "");
}

// Путь с гарантированным завершающим слэшем — для честного prefix-сравнения
function withSlash(p) {
	return p.endsWith("/") ? p : `${p}/`;
}

// Пересечение корней: равенство, вложенность в любую сторону
function pathsOverlap(a, b) {
	const A = withSlash(a);
	const B = withSlash(b);
	return A === B || A.startsWith(B) || B.startsWith(A);
}

function findProjectConflicts(name, root_path) {
	const all = db.prepare("SELECT name, root_path FROM projects").all();
	const norm = normalizeProjectName(name);
	return all.filter(
		(p) =>
			p.name !== name &&
			(normalizeProjectName(p.name) === norm || pathsOverlap(p.root_path, root_path)),
	);
}

function requireProject(name) {
	const p = getProjectStmt.get(name);
	if (!p) {
		throw new Error(
			`Проект "${name}" не зарегистрирован — сначала register_project (list_projects покажет существующие)`,
		);
	}
	return p;
}

// ============ политика ============

function readPolicy() {
	return readPolicyFile({ dbPath: DB_PATH });
}

// Эффективная политика проекта (строка projects). Файл читается заново:
// на машине может быть несколько серверов, все видят одну политику.
function policyForProject(projectRow) {
	return resolvePolicy({ file: readPolicy(), project: projectRow });
}

// Политики пространств — вниз, как инбокс: облако отдаёт, сервер пишет кэш.
// В журнал облако не пишет никогда — policy.json это конфиг.
async function pullWorkspacePolicies() {
	const config = loadSyncConfig({ dbPath: DB_PATH, log: () => {} });
	if (!config?.url || !config?.token) return { skipped: true };
	const result = await fetchWorkspacePolicies({
		config,
		policyUrl: policyUrlFromBase(config.url),
	});
	if (result.error) return result;
	const file = applyWorkspacePolicies(readPolicy(), result.workspaces);
	writePolicyFile({ dbPath: DB_PATH, file });
	return { updated: Object.keys(file.workspaces).length };
}

function describePull(result) {
	if (result.skipped) return null;
	if (result.error) return `политика пространств: ошибка — ${result.error}`;
	return `политика пространств: обновлено ${result.updated}`;
}

// Стартовый pull — fire-and-forget: офлайн не мешает работе по кэшу.
setImmediate(async () => {
	const line = describePull(await pullWorkspacePolicies());
	if (line?.includes("ошибка")) console.error(`actari: ${line}`);
});

function today() {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

// ============ инструменты ============

// Описания четырёх актов рендерятся один раз на сессию из политики старта.
const STARTUP_POLICY = pickStartupPolicy(readPolicy());
const BASE_DESCRIPTIONS = {
	draft:
		"Поставить задачу в журнал (событие TaskDrafted). task_text — полный текст задания для исполнителя.",
	delegate:
		"Отметить делегацию задачи исполнителю (событие Delegated). Допустимо из DRAFT или REWORK. " +
		"Запуск исполнителя — вне журнала.",
	report: "Записать отчёт исполнителя (событие ReportSubmitted). Допустимо из DELEGATED.",
	accept:
		"Принять задачу (событие Accepted). Допустимо из REPORTED. evidence — чем подтверждена " +
		"приёмка (хэш коммита, ссылка на прогон); обязательность задаёт политика проекта.",
};
const describe = (act) => renderToolDescription(BASE_DESCRIPTIONS[act], STARTUP_POLICY, act);

const TOOLS = [
	{
		name: "search_precedents",
		description:
			"Полнотекстовый поиск похожих задач (задания + отчёты), артефактов и инцидентов по всем проектам. " +
			"Инциденты — первые 280 символов; целиком — с full: true.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Ключевые слова (любой язык)" },
				limit: { type: "number", description: "Максимум задач (default 5)" },
				full: { type: "boolean", description: "true — инциденты целиком" },
			},
			required: ["query"],
		},
		handler: ({ query, limit = 5, full = false }) => {
			const expr = ftsExpr(query);
			const tasks = expr
				? db
						.prepare(
							`SELECT t.task_id, t.project, t.title, t.status, t.outcome, t.evidence,
							        snippet(task_fts, 1, '[', ']', '…', 12) AS task_snippet,
							        snippet(task_fts, 2, '[', ']', '…', 12) AS report_snippet
							 FROM task_fts JOIN tasks t ON t.rowid = task_fts.rowid
							 WHERE task_fts MATCH ? ORDER BY rank LIMIT ?`,
						)
						.all(expr, limit)
				: [];
			const words = query.split(/\s+/).filter(Boolean);
			const cond = words.map(() => "(description LIKE ? OR lesson LIKE ?)").join(" OR ");
			const args = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
			const incidentRows = words.length
				? db
						.prepare(
							`SELECT id, task_id, description, lesson, at FROM incidents WHERE ${cond} ORDER BY at DESC LIMIT 10`,
						)
						.all(...args)
				: [];
			const incidents = full ? incidentRows : incidentRows.map(compactIncident);
			const artifacts = expr
				? db
						.prepare(
							`SELECT a.id, a.project, a.kind, a.title, a.task_id, a.at,
							        snippet(artifact_fts, 1, '[', ']', '…', 12) AS body_snippet
							 FROM artifact_fts JOIN artifacts a ON a.id = artifact_fts.rowid
							 WHERE artifact_fts MATCH ? ORDER BY rank LIMIT ?`,
						)
						.all(expr, limit)
				: [];
			return { tasks, artifacts, incidents };
		},
	},
	{
		name: "register_project",
		description:
			"Зарегистрировать проект (событие ProjectRegistered): имя = неймспейс задач, root_path = " +
			"привязка к папке на диске, cloud_workspace_id = маппинг на пространство в облаке (опционально). " +
			"Повторная регистрация обновляет путь/маппинг. Задачи и артефакты принимаются только для зарегистрированных проектов.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Короткое имя (латиница/цифры/дефисы), напр. dom-pro",
				},
				root_path: { type: "string", description: "Абсолютный путь к корню проекта" },
				cloud_workspace_id: {
					type: "string",
					description: "Id пространства в облаке (опционально)",
				},
				force: {
					type: "boolean",
					description:
						"Осознанно зарегистрировать несмотря на похожий проект (guard от почти-дублей)",
				},
			},
			required: ["name", "root_path"],
		},
		handler: ({ name, root_path, cloud_workspace_id, force }) => {
			if (!/^[a-z0-9-]+$/.test(name)) {
				throw new Error("Имя проекта: латиница/цифры/дефисы — оно входит в task_id как неймспейс");
			}
			// Guard от почти-дублей: похожее имя или пересекающийся корень.
			// Точное совпадение имени — легальная перерегистрация (обновление пути).
			if (!force) {
				const conflicts = findProjectConflicts(name, root_path);
				if (conflicts.length > 0) {
					const listing = conflicts.map((p) => `"${p.name}" (${p.root_path})`).join(", ");
					throw new Error(
						`Похоже, проект уже зарегистрирован: ${listing}. ` +
							"Используй существующее имя (resolve_project найдёт проект по пути), " +
							"либо повтори с force: true, если это осознанно отдельный проект.",
					);
				}
			}
			appendEvent(
				"_general",
				"ProjectRegistered",
				JSON.stringify({ name, root_path, cloud_workspace_id: cloud_workspace_id ?? null }),
			);
			return getProjectStmt.get(name);
		},
	},
	{
		name: "resolve_project",
		description:
			"Найти уже зарегистрированный проект ПЕРЕД register_project/бутстрапом: по пути (какой проект " +
			"покрывает эту папку) и/или по имени (похожие имена, dompro ~ dom-pro). Пустой ответ = проекта нет.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Абсолютный путь (папка проекта или файла внутри него)",
				},
				name: { type: "string", description: "Предполагаемое имя проекта" },
			},
		},
		handler: ({ path, name }) => {
			const all = db.prepare("SELECT name, root_path, cloud_workspace_id, at FROM projects").all();
			const byPath = path
				? all.filter(
						(p) =>
							withSlash(path).startsWith(withSlash(p.root_path)) || pathsOverlap(p.root_path, path),
					)
				: [];
			const norm = name ? normalizeProjectName(name) : null;
			const byName = norm
				? all.filter(
						(p) =>
							normalizeProjectName(p.name) === norm ||
							normalizeProjectName(p.name).includes(norm) ||
							norm.includes(normalizeProjectName(p.name)),
					)
				: [];
			const seen = new Set();
			const matches = [...byPath, ...byName].filter((p) => !seen.has(p.name) && seen.add(p.name));
			return { matches };
		},
	},
	{
		name: "list_projects",
		description: "Реестр проектов: имя, путь на диске, маппинг на пространство в облаке.",
		inputSchema: { type: "object", properties: {} },
		handler: () =>
			db
				.prepare("SELECT name, root_path, cloud_workspace_id, at FROM projects ORDER BY name")
				.all(),
	},
	{
		name: "draft_task",
		description: describe("draft"),
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "Имя проекта, напр. dom-pro" },
				slug: { type: "string", description: "Короткий латинский слаг, напр. gantt-ranks" },
				title: { type: "string", description: "Человекочитаемое название" },
				task_text: { type: "string", description: "Полный текст задания для исполнителя" },
				task_id: {
					type: "string",
					description: "Явный id (иначе соберётся как <project>/<дата>-<slug>)",
				},
				intent_task_id: {
					type: "string",
					description:
						"Id облачного Task-намерения (из take): связка journal→intent едет в payload события",
				},
			},
			required: ["project", "title", "task_text"],
		},
		handler: async ({ project, slug, title, task_text, task_id, intent_task_id }) => {
			if (!task_id) {
				if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
					throw new Error("Нужен slug (латиница/цифры/дефисы) или явный task_id");
				}
				task_id = `${project}/${today()}-${slug}`;
			} else if (!task_id.startsWith(`${project}/`)) {
				throw new Error(
					`task_id должен начинаться с "${project}/" — неймспейс проекта входит в id`,
				);
			}
			const projectRow = requireProject(project);
			const { policy } = policyForProject(projectRow);
			const requiredTitle = policy.enforce.draft_requires_artifact;
			if (requiredTitle) {
				const artifactTitle = renderArtifactTitle(requiredTitle, project);
				const has = db
					.prepare("SELECT 1 FROM artifacts WHERE project = ? AND title = ? LIMIT 1")
					.get(project, artifactTitle);
				if (!has) {
					throw new Error(
						`политика «${policy.name}» требует артефакт «${artifactTitle}» до постановки задач — создай его (record_artifact kind=spec, промпт bootstrap) или измени политику`,
					);
				}
			}
			const existing = getTaskStmt.get(task_id);
			if (existing && !["DRAFT", "REWORK"].includes(existing.status)) {
				throw new Error(
					`Задача ${task_id} уже в статусе ${existing.status} — редактировать нельзя, заведи новую`,
				);
			}
			// Намерение: взято этим пользователем и не закрыто человеком; проект
			// ведёт в его пространство (спека §9.2–9.3).
			const gate = await checkIntentGate("draft", intent_task_id ?? null);
			// Правка DRAFT или REWORK не меняет created_at задачи: после возврата
			// намерения облако считает её историей. Отказ не трогает увиденный
			// reopenedAt — иначе следующий delegate прошёл бы по «свежей» метке.
			if (existing && intent_task_id && gate?.view) {
				const seenReopened = readIntentMeta(db, draftReopenedKey(task_id, intent_task_id));
				if (seenReopened !== null && (gate.view.reopenedAt ?? "") !== seenReopened) {
					const when = formatWhen(gate.view.reopenedAt);
					const next = `draft_task с другим slug и intent_task_id: "${intent_task_id}"`;
					throw new Error(
						existing.status === "REWORK"
							? `попытка ${task_id} заведена до возврата намерения в инбокс (${when}) — облако считает её историей. Закрой её: mark_failed { task_id: "${task_id}", reason: "намерение возвращено в инбокс" }, затем заведи новую задачу: ${next}.`
							: `черновик ${task_id} заведён до возврата намерения в инбокс (${when}) — он остаётся в журнале как история. Заведи новую задачу: ${next}.`,
					);
				}
			}
			await checkProjectBinding(projectRow, gate?.view);
			// Связка с намерением — свободный payload события: схема БД не меняется,
			// облачный транслятор прочитает intent_task_id при материализации.
			const drafted = emit(task_id, "TaskDrafted", {
				project,
				title,
				task_text,
				...(intent_task_id ? { intent_task_id } : {}),
			});
			if (intent_task_id && gate?.fromCloud) {
				writeIntentMeta(db, draftReopenedKey(task_id, intent_task_id), gate.view.reopenedAt ?? "");
			}
			return drafted;
		},
	},
	{
		name: "delegate",
		description: describe("delegate"),
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				executor: { type: "string", description: "grok / codex / subagent / inline" },
			},
			required: ["task_id", "executor"],
		},
		handler: ({ task_id, executor }) =>
			emitWithIntentGate(task_id, "Delegated", "delegate", { executor }),
	},
	{
		name: "submit_report",
		description: describe("report"),
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				report: { type: "string", description: "Полный текст отчёта исполнителя" },
			},
			required: ["task_id", "report"],
		},
		handler: ({ task_id, report }) =>
			emitWithIntentGate(task_id, "ReportSubmitted", "report", { report }),
	},
	{
		name: "accept",
		description: describe("accept"),
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				evidence: {
					type: "string",
					description:
						"Подтверждение приёмки: хэш коммита/мержа, ссылка на прогон CI, вывод тестов",
				},
				outcome: { type: "string", description: "accepted (default) | accepted-with-fixes" },
			},
			required: ["task_id"],
		},
		handler: async ({ task_id, evidence, outcome = "accepted" }) => {
			const task = getTaskStmt.get(task_id);
			if (!task) throw new Error(`Задача ${task_id} не найдена`);
			const trimmed = typeof evidence === "string" ? evidence.trim() : "";
			const { policy } = policyForProject(requireProject(task.project));
			if (policy.enforce.accept_requires_evidence && !trimmed) {
				const hint = policy.guidance.accept.trim();
				throw new Error(
					`политика «${policy.name}» требует подтверждение приёмки: передай evidence (хэш коммита, ссылка на прогон).` +
						(hint ? `\n\n${hint}` : ""),
				);
			}
			return emitWithIntentGate(task_id, "Accepted", "accept", {
				outcome,
				...(trimmed ? { evidence: trimmed } : {}),
			});
		},
	},
	{
		name: "request_rework",
		description:
			"Вернуть задачу на доработку (событие ReworkRequested), из REPORTED. Дальше — новая delegate.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				reason: { type: "string", description: "Что именно не так (по итогам верификации)" },
			},
			required: ["task_id", "reason"],
		},
		handler: ({ task_id, reason }) =>
			emitWithIntentGate(task_id, "ReworkRequested", "rework", { reason }),
	},
	{
		name: "mark_failed",
		description: "Закрыть задачу как проваленную (событие Failed), из DELEGATED/REPORTED/REWORK.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				reason: { type: "string" },
			},
			required: ["task_id", "reason"],
		},
		handler: ({ task_id, reason }) => emit(task_id, "Failed", { reason }),
	},
	{
		name: "record_incident",
		description:
			"Записать грабли/урок (событие IncidentRecorded). Для инцидентов вне конкретной задачи " +
			"task_id можно опустить.",
		inputSchema: {
			type: "object",
			properties: {
				description: { type: "string", description: "Что случилось" },
				lesson: { type: "string", description: "Как обходить впредь" },
				task_id: { type: "string" },
			},
			required: ["description", "lesson"],
		},
		handler: ({ description, lesson, task_id = "_general" }) => {
			appendEvent(task_id, "IncidentRecorded", JSON.stringify({ description, lesson }));
			return { recorded: true, task_id, description, lesson };
		},
	},
	{
		name: "link_tasks",
		description:
			"Связать задачи (событие TaskLinked, направленно from → to). kind: continues " +
			"(«from — продолжение to»; для продолжения заводи НОВУЮ задачу и линкуй на старую), " +
			"relates, blocks («from блокирует to»), discovered_from («from найдена в ходе to»).",
		inputSchema: {
			type: "object",
			properties: {
				from_task_id: { type: "string" },
				to_task_id: { type: "string" },
				kind: { type: "string", description: "continues | relates | blocks | discovered_from" },
			},
			required: ["from_task_id", "to_task_id", "kind"],
		},
		handler: ({ from_task_id, to_task_id, kind }) => {
			if (!["continues", "relates", "blocks", "discovered_from"].includes(kind)) {
				throw new Error("kind: continues | relates | blocks | discovered_from");
			}
			if (from_task_id === to_task_id) throw new Error("Задача не может ссылаться на себя");
			for (const id of [from_task_id, to_task_id]) {
				if (!getTaskStmt.get(id)) throw new Error(`Задача ${id} не найдена`);
			}
			appendEvent(from_task_id, "TaskLinked", JSON.stringify({ to_task_id, kind }));
			return db
				.prepare("SELECT from_task, to_task, kind, at FROM task_links WHERE from_task = ?")
				.all(from_task_id);
		},
	},
	{
		name: "record_artifact",
		description:
			"Зафиксировать артефакт: спеку, план, ADR, решение или заметку (событие ArtifactRecorded). " +
			"Повторная запись с тем же title = новая версия (старая остаётся в истории).",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string" },
				kind: { type: "string", description: "spec | plan | adr | decision | note | doc" },
				title: { type: "string" },
				body: { type: "string", description: "Полный текст артефакта (markdown)" },
				task_id: { type: "string", description: "Опциональная привязка к задаче журнала" },
			},
			required: ["project", "kind", "title", "body"],
		},
		handler: ({ project, kind, title, body, task_id = "_general" }) => {
			if (!["spec", "plan", "adr", "decision", "note", "doc"].includes(kind)) {
				throw new Error("kind: spec | plan | adr | decision | note | doc");
			}
			requireProject(project);
			appendEvent(task_id, "ArtifactRecorded", JSON.stringify({ project, kind, title, body }));
			return db
				.prepare(
					"SELECT id, task_id, project, kind, title, at FROM artifacts ORDER BY id DESC LIMIT 1",
				)
				.get();
		},
	},
	{
		name: "get_artifact",
		description: "Полный текст артефакта по id (id даёт search_precedents / list_artifacts).",
		inputSchema: {
			type: "object",
			properties: { id: { type: "number" } },
			required: ["id"],
		},
		handler: ({ id }) => {
			const a = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
			if (!a) throw new Error(`Артефакт ${id} не найден`);
			return a;
		},
	},
	{
		name: "list_artifacts",
		description:
			"Список артефактов с фильтрами по проекту/типу/задаче (без тела — только заголовки).",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string" },
				kind: { type: "string", description: "spec | plan | adr | decision | note | doc" },
				task_id: { type: "string" },
				limit: { type: "number", description: "default 20" },
			},
		},
		handler: ({ project, kind, task_id, limit = 20 }) => {
			const cond = [];
			const args = [];
			if (project) {
				cond.push("project = ?");
				args.push(project);
			}
			if (kind) {
				cond.push("kind = ?");
				args.push(kind);
			}
			if (task_id) {
				cond.push("task_id = ?");
				args.push(task_id);
			}
			const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
			return db
				.prepare(
					`SELECT id, task_id, project, kind, title, at FROM artifacts ${where} ORDER BY id DESC LIMIT ?`,
				)
				.all(...args, limit);
		},
	},
	{
		name: "connect",
		description:
			"Подключить журнал к облаку Actari (или к своему on-premise через url): проверяет связь (GET курсора с токеном) и при успехе " +
			"сам пишет sync.json рядом с базой — ручная настройка не нужна. Токен личный: один токен " +
			"покрывает все пространства пользователя, журнал раскладывается по ним согласно sync_scope. " +
			"journal_id по умолчанию собирается из имени пользователя и машины. Повторный connect " +
			"перезаписывает конфиг (осознанная смена облака/токена); чтобы ДОБАВИТЬ вторую цель, а не " +
			"заменить текущую, передай alias — журнал будет пушиться во все цели сразу. " +
			"При ошибке связи конфиг не трогается.",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description:
						"Базовый URL инстанса: не указан — управляемое облако Actari; свой on-premise — напр. https://wh.acme.internal (можно с префиксом прокси). Пути эндпоинтов сервер добавит сам",
				},
				token: { type: "string", description: "Личный MCP-токен (Bearer)" },
				journal_id: {
					type: "string",
					description: "Имя журнала (default: <username>-<hostname>, нормализованное)",
				},
				alias: {
					type: "string",
					description:
						"Имя цели в конфиге. Задан — цель добавляется к уже настроенным (журнал " +
						"поедет во все); не задан — конфиг перезаписывается как раньше",
				},
			},
			required: ["token"],
		},
		handler: async ({ url, token, journal_id, alias }) => {
			const journalId = journal_id ?? defaultJournalId();
			if (!/^[a-z0-9-]+$/.test(journalId)) {
				return `не подключено: journal_id «${journalId}» — допустимы только строчные латинские буквы, цифры и дефисы`;
			}
			// На вход — базовый адрес инстанса; пути эндпоинтов знает сервер.
			// Полный URL журнала-синка тоже принимаем: так писали до 0.8.1.
			let baseUrl;
			let cursorUrl;
			try {
				baseUrl = normalizeBaseUrl(resolveCloudUrl({ url }));
				cursorUrl = new URL(syncUrlFromBase(baseUrl));
			} catch {
				return `не подключено: некорректный url «${url}»`;
			}
			cursorUrl.searchParams.set("journalId", journalId);
			let res;
			try {
				res = await fetch(cursorUrl, {
					headers: {
						authorization: `Bearer ${token}`,
						"cache-control": "no-store",
						pragma: "no-cache",
					},
				});
			} catch (err) {
				const code = err.cause?.code ?? err.message;
				// Частый случай on-premise: сертификат внутреннего CA.
				const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(code))
					? " — похоже на самоподписанный сертификат; укажите корневой сертификат через NODE_EXTRA_CA_CERTS=/path/to/ca.pem"
					: "";
				return `не подключено: ${cursorUrl.origin} недоступен (${code})${hint}`;
			}
			if (!res.ok) {
				const reason =
					res.status === 401
						? "токен не принят (невалидный или отозванный)"
						: res.status === 403
							? "доступ запрещён"
							: "облако отвергло запрос";
				return `не подключено: HTTP ${res.status} — ${reason}. Конфиг не записан.`;
			}
			let workspaces;
			try {
				workspaces = parseWorkspaces(await res.json());
			} catch {
				return `не подключено: ${cursorUrl.origin} ответил не-JSON (это точно адрес инстанса Actari?). Конфиг не записан.`;
			}
			if (!workspaces) {
				return "не подключено: облако не вернуло workspaces (несовместимая версия сервера). Конфиг не записан.";
			}
			// Конфиг: одна цель — плоский вид (как до многоцелевого синка), несколько —
			// {targets: [...]}. Цель с тем же alias (или тем же url+журналом)
			// заменяется, остальные остаются на месте.
			const existing = readSyncConfigFile({ dbPath: DB_PATH });
			const existingTargets = Array.isArray(existing?.targets)
				? existing.targets.filter((t) => t && typeof t === "object" && !Array.isArray(t))
				: existing?.url || existing?.token || existing?.journalId
					? [existing]
					: [];
			const fresh = { ...(alias ? { alias } : {}), url: baseUrl, token, journalId };
			let config;
			if (alias || existingTargets.length > 1 || Array.isArray(existing?.targets)) {
				const sameTarget = (t, index) =>
					alias
						? targetAlias(t, index) === alias
						: t.url === baseUrl && (t.journalId ?? journalId) === journalId;
				const kept = existingTargets.filter((t, index) => !sameTarget(t, index));
				config = { targets: [...kept, fresh] };
			} else {
				config = { url: baseUrl, token, journalId };
			}
			const configPath = writeSyncConfig({ dbPath: DB_PATH, config });
			scheduleAutoPush();
			// Токен личный: показать, какие пространства он открывает, — иначе
			// человек не узнает, куда вообще может уехать журнал.
			const spaces =
				workspaces.length === 0
					? "пространств у пользователя нет — журнал пока никуда не поедет"
					: `пространства: ${workspaces.map((w) => `${w.slug} (курсор ${w.lastSeq})`).join(", ")}`;
			let connected = `подключено: журнал ${journalId}, ${spaces}, конфиг ${configPath}`;
			if (config.targets) {
				// Целей стало несколько — человек должен видеть, куда теперь едет журнал.
				const aliases = config.targets.map((t, index) => targetAlias(t, index)).join(", ");
				connected += `\nцелей синка: ${config.targets.length} (${aliases}) — журнал поедет во все`;
			}
			// Журнал один на машину: сказать про область надо здесь, а не после
			// того, как чужие задачи уже уехали (или молча не уехало ничего).
			const registry = db.prepare("SELECT name, cloud_workspace_id FROM projects").all();
			if (workspaces.length === 1) {
				const scope = resolveSyncScope({
					projects: registry,
					workspaceId: workspaces[0].id,
					workspaceCount: 1,
				});
				if (!scope.projects && registry.length > 1) {
					return (
						`${connected}\nвнимание: область синка не задана — в пространство ${workspaces[0].slug} уедут ВСЕ ` +
						`проекты журнала (${registry.map((p) => p.name).join(", ")}). ` +
						"Ограничить: sync_scope { projects: [...] }."
					);
				}
			} else if (workspaces.length > 1 && registry.length > 0) {
				const mapped = registry.filter((p) => p.cloud_workspace_id);
				if (mapped.length === 0) {
					return (
						`${connected}\nвнимание: пространств несколько, а область синка не задана — ` +
						"журнал НИКУДА не поедет, пока проекты не привязаны: " +
						"sync_scope { workspace: <slug>, projects: [...] }."
					);
				}
			}
			return connected;
		},
	},
	{
		name: "sync_scope",
		description:
			"Область синка: какие проекты журнала в какое пространство уезжают. Токен личный, " +
			"пространств у пользователя может быть несколько — привязка называет пространство " +
			'его SLUG\'ом: sync_scope { workspace: "dom-pro", projects: [...] } (список ' +
			"пространств спрашивается у облака, id руками знать не нужно). Пустой массив " +
			"projects снимает привязку к этому пространству. Параметр target выбирает СЕРВЕР " +
			"при нескольких целях синка (алиас из sync.json). Без аргументов — показать по " +
			"каждому серверу пространства пользователя и какие проекты в какое уедут. " +
			"Локальный журнал один на машину и хранит все проекты сразу — без области при " +
			"нескольких пространствах журнал никуда не поедет.",
		inputSchema: {
			type: "object",
			properties: {
				projects: {
					type: "array",
					items: { type: "string" },
					description:
						"Имена зарегистрированных проектов, которые синкаются в это пространство. " +
						"Пустой массив снимает привязку со всех проектов этого пространства.",
				},
				workspace: {
					type: "string",
					description:
						"Slug пространства, к которому привязываются проекты (из списка облака). " +
						"Не нужен, если пространство одно.",
				},
				target: {
					type: "string",
					description:
						"Цель синка (СЕРВЕР): алиас из sync.json или её url. Не нужен, если цель одна.",
				},
			},
		},
		handler: async ({ projects, workspace, target }) => {
			const targets = loadSyncTargets({ dbPath: DB_PATH });
			if (targets.length === 0) return "синк не настроен (нет sync.json) — сначала connect";

			// Список пространств локально знать неоткуда — спрашиваем каждое облако.
			const entries = [];
			for (const t of targets) {
				entries.push({ target: t, cursor: await fetchCursor({ config: t }) });
			}

			// Отчёт по одному серверу: строка на каждое пространство пользователя.
			const describe = (entry) => {
				const registry = db.prepare("SELECT name, cloud_workspace_id FROM projects").all();
				const workspaces = entry.cursor.workspaces ?? [];
				if (workspaces.length === 0) {
					return ["пространств у пользователя нет — журналу некуда ехать"];
				}
				return workspaces.map((ws) => {
					const scope = resolveSyncScope({
						projects: registry,
						workspaceId: ws.id,
						workspaceCount: workspaces.length,
					});
					const source =
						scope.source === "env"
							? "ACTARI_SYNC_PROJECTS"
							: scope.source === "mapping"
								? "маппинг cloud_workspace_id"
								: "область не задана";
					if (!scope.projects) {
						return `${ws.slug}: ВСЕ проекты (${source})`;
					}
					const names = [...scope.projects].join(", ") || "(пусто — не уедет ничего)";
					return `${ws.slug}: ${names} (${source})`;
				});
			};

			if (Array.isArray(projects)) {
				// Привязка всегда к ОДНОМУ пространству одного сервера.
				let chosen;
				if (typeof target === "string" && target.trim()) {
					const needle = target.trim().toLowerCase();
					chosen = entries.find(
						(e) =>
							e.target.alias.toLowerCase() === needle ||
							(e.target.url ?? "").toLowerCase() === needle,
					);
					if (!chosen) {
						throw new Error(
							`Цель «${target}» не найдена. Доступные: ${entries.map((e) => e.target.alias).join(", ")}`,
						);
					}
				} else if (entries.length === 1) {
					chosen = entries[0];
				} else {
					throw new Error(
						`Целей синка несколько — укажи target: ${entries.map((e) => e.target.alias).join(", ")}`,
					);
				}

				if (chosen.cursor.error) {
					return `не удалось спросить облако (${chosen.target.alias}): ${chosen.cursor.error}`;
				}
				const workspaces = chosen.cursor.workspaces ?? [];
				if (workspaces.length === 0) {
					return "у пользователя нет пространств в этом облаке — привязывать не к чему";
				}
				// Пространство называется slug'ом — id человеку знать не нужно.
				let chosenWs;
				if (typeof workspace === "string" && workspace.trim()) {
					const needle = workspace.trim().toLowerCase();
					chosenWs = workspaces.find(
						(ws) => ws.slug.toLowerCase() === needle || ws.id === workspace.trim(),
					);
					if (!chosenWs) {
						throw new Error(
							`Пространство «${workspace}» не найдено. Доступные: ${workspaces.map((ws) => ws.slug).join(", ")}`,
						);
					}
				} else if (workspaces.length === 1) {
					chosenWs = workspaces[0];
				} else {
					throw new Error(
						`Пространств несколько — укажи workspace: ${workspaces.map((ws) => ws.slug).join(", ")}`,
					);
				}

				const known = db.prepare("SELECT name, root_path, cloud_workspace_id FROM projects").all();
				const byName = new Map(known.map((p) => [p.name, p]));
				const missing = projects.filter((name) => !byName.has(name));
				if (missing.length > 0) {
					throw new Error(
						`Не зарегистрированы: ${missing.join(", ")} (list_projects покажет реестр)`,
					);
				}
				// Маппинг живёт в проекции projects, а она наполняется событиями:
				// меняем его перерегистрацией, а не правкой таблицы.
				// Снятие привязки — пустая строка, а не null: триггер схемы делает
				// coalesce(excluded, старое), то есть null трактует как «не трогать»
				// (так register_project без cloud_workspace_id не стирает маппинг).
				// Чужие пространства не трогаем: снимаем только привязку к текущему —
				// именно поэтому соседнее пространство не теряет свои проекты.
				const wanted = new Set(projects);
				for (const project of known) {
					const targetWorkspace = wanted.has(project.name)
						? chosenWs.id
						: project.cloud_workspace_id === chosenWs.id
							? ""
							: project.cloud_workspace_id;
					if ((targetWorkspace ?? null) === (project.cloud_workspace_id ?? null)) continue;
					appendEvent(
						"_general",
						"ProjectRegistered",
						JSON.stringify({
							name: project.name,
							root_path: project.root_path,
							cloud_workspace_id: targetWorkspace,
						}),
					);
				}
			}

			const footer =
				"Привязать проекты: sync_scope { workspace: <slug>, projects: [...] }" +
				(entries.length > 1 ? " (+ target: <алиас> для выбора сервера)" : "") +
				".\nОбщие события (task_id = _general) и ProjectRegistered при активной области не отправляются.";

			// Один сервер — плоский отчёт по пространствам.
			if (entries.length === 1) {
				const [entry] = entries;
				if (entry.cursor.error) return `не удалось спросить облако: ${entry.cursor.error}`;
				const lines = describe(entry).map((line) => `- ${line}`);
				return `область синка (пространства пользователя):\n${lines.join("\n")}\n${footer}`;
			}

			const blocks = entries.map((entry) => {
				if (entry.cursor.error) {
					return `- ${entry.target.alias} (${entry.target.url}): облако недоступно — ${entry.cursor.error}`;
				}
				const lines = describe(entry).map((line) => `    - ${line}`);
				return `- ${entry.target.alias} (${entry.target.url}):\n${lines.join("\n")}`;
			});
			return `область синка по целям (${entries.length}):\n${blocks.join("\n")}\n${footer}`;
		},
	},
	{
		name: "sync",
		description:
			"Принудительно отправить журнал в облако (push, только вверх): GET курсор → " +
			"POST события с seq > курсора. Конфиг: sync.json рядом с базой (url, token, journalId) " +
			"либо env ACTARI_SYNC_URL/TOKEN/JOURNAL_ID. Без конфига синк выключен.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const targets = loadSyncTargets({ dbPath: DB_PATH });
			if (targets.length === 0) return "синк не настроен (нет sync.json)";
			const result = await pushJournal({ dbPath: DB_PATH, targets });
			for (const target of result.targets) {
				for (const warning of target.warnings ?? []) pushNotice(syncWarningText(warning));
			}
			const policyLine = describePull(await pullWorkspacePolicies());
			const withPolicy = (text) => (policyLine ? `${text}\n${policyLine}` : text);
			if (targets.length === 1) {
				const [only] = result.targets;
				if (only.error) return withPolicy(`ошибка синка: ${only.error}`);
				const workspaces = only.workspaces ?? [];
				if (workspaces.length === 0) {
					return withPolicy("отправлено 0 событий: у пользователя нет пространств");
				}
				if (workspaces.length === 1) {
					return withPolicy(`отправлено ${only.pushed} событий, курсор ${only.lastSeq}`);
				}
				// Несколько пространств: сводка по каждому — упавшее не должно
				// прятаться за успехом соседнего.
				const wsLines = workspaces.map((ws) =>
					ws.error
						? `- ${ws.slug}: ошибка — ${ws.error}`
						: `- ${ws.slug}: отправлено ${ws.pushed} событий, курсор ${ws.lastSeq}`,
				);
				return withPolicy(
					`пространств ${workspaces.length}, отправлено ${only.pushed} событий:\n${wsLines.join("\n")}`,
				);
			}
			// Несколько целей: сводка по каждой — упавшая цель не должна прятаться
			// за успехом соседней.
			const lines = result.targets.map((t) =>
				t.error
					? `- ${t.alias}: ошибка синка — ${t.error}`
					: `- ${t.alias}: отправлено ${t.pushed} событий, курсор ${t.lastSeq}`,
			);
			const failed = result.targets.filter((t) => t.error).length;
			const head = failed
				? `целей ${result.targets.length}, из них с ошибкой ${failed}:`
				: `целей ${result.targets.length}, все успешно:`;
			return withPolicy(`${head}\n${lines.join("\n")}`);
		},
	},
	{
		name: "inbox",
		description:
			"Инбокс намерений из облака: мои и свободные задачи фич в работе, мои первыми, по приоритету " +
			"(pull: облако только отдаёт список, забирается через take). Токен личный — у каждой строки видно " +
			"пространство и проект журнала, привязанный к нему. При нескольких целях синка собирается со всех.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const targets = loadSyncTargets({ dbPath: DB_PATH, log: () => {} });
			if (targets.length === 0) return "инбокс не настроен (нет sync.json)";
			const usable = targets.filter((target) => target.url && target.token);
			if (usable.length === 0) return "инбокс не настроен: в конфиге синка нужны url и token";
			const items = new Map();
			const errors = [];
			for (const target of usable) {
				const label = usable.length > 1 ? `${target.alias}: ` : "";
				try {
					const res = await fetch(inboxUrlFromBase(target.url), {
						headers: { authorization: `Bearer ${target.token}` },
						signal: AbortSignal.timeout(INBOX_TIMEOUT),
					});
					if (!res.ok) {
						errors.push(`${label}HTTP ${res.status}`);
						continue;
					}
					const body = await res.json();
					for (const item of Array.isArray(body?.items) ? body.items : []) {
						if (!items.has(item.id)) items.set(item.id, item);
					}
				} catch (err) {
					errors.push(`${label}${err.message}`);
				}
			}
			if (items.size === 0) {
				return errors.length > 0
					? `ошибка инбокса: ${errors.join("; ")}`
					: "инбокс пуст: 0 намерений";
			}
			const lines = [...items.values()].map((item) =>
				formatInboxItem(item, projectsOfWorkspace(item.workspace?.id)),
			);
			const tail = errors.length > 0 ? `\n\nчасть целей не ответила: ${errors.join("; ")}` : "";
			return `${items.size} намерений:\n${lines.join("\n")}\n\nЗабрать: take { task_id: <id> }.${tail}`;
		},
	},
	{
		name: "take",
		description:
			"Забрать намерение из инбокса облака (атомарно; повторный take своего — тот же контекст). " +
			"Отвечает болванкой для draft_task: контекст фичи, текст намерения, критерии приёмки с версией, " +
			"приоритет, проект журнала этого пространства, intent_task_id. Чужое, отменённое или из фичи " +
			"не в работе — отказ с причиной. Дальше: search_precedents → draft_task (с intent_task_id) → delegate → …",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Id облачного Task-намерения (из inbox)" },
			},
			required: ["task_id"],
		},
		handler: async ({ task_id }) => {
			const targets = loadSyncTargets({ dbPath: DB_PATH, log: () => {} });
			if (targets.length === 0) return "инбокс не настроен (нет sync.json)";
			if (!targets.some((target) => target.url && target.token)) {
				return "инбокс не настроен: в конфиге синка нужны url и token";
			}
			const errors = [];
			let forbidden = false;
			for (const target of orderedTargets(readIntentCache(db, task_id)?.target_url)) {
				let res;
				try {
					res = await fetch(inboxUrlFromBase(target.url), {
						method: "POST",
						headers: {
							authorization: `Bearer ${target.token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ taskId: task_id }),
						signal: AbortSignal.timeout(INBOX_TIMEOUT),
					});
				} catch (err) {
					errors.push(err.message);
					continue;
				}
				// Намерение живёт в одной из целей: 404 — ищем в следующей.
				if (res.status === 404) continue;
				if (res.status === 403) {
					forbidden = true;
					continue;
				}
				let body = null;
				try {
					body = await res.json();
				} catch {
					body = null;
				}
				if (res.status === 409) return formatTakeRejection(task_id, body);
				if (!res.ok || !body?.context) {
					errors.push(`HTTP ${res.status}`);
					continue;
				}
				// Увиденные критерии — те, что отдал take: смена до draft даст разницу.
				if (body.intent?.id) {
					writeIntentView(db, { targetUrl: target.url, view: body.intent, markSeen: true });
				}
				return formatTakeContext(body, projectsOfWorkspace(body.context.workspace?.id));
			}
			if (errors.length > 0) return `ошибка take: ${errors.join("; ")}`;
			if (forbidden) return "ошибка take: HTTP 403 — намерение из пространства, где ты не участник";
			return `намерение ${task_id} не найдено в облаке`;
		},
	},
	{
		name: "intent_status",
		description:
			"Состояние облачного намерения: выведенное состояние и факт журнала, ручное решение человека " +
			"(отменено / сделано вручную) с автором и комментарием, исполнитель, приоритет, критерии приёмки " +
			"с версией и разницей с тем, что ты уже видел. Помечает критерии увиденными — после этого accept " +
			"по новым критериям пройдёт. task_id — id намерения или журнальной задачи (project/…).",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Id намерения облака или задачи журнала" },
			},
			required: ["task_id"],
		},
		handler: async ({ task_id }) => {
			const intentTaskId = String(task_id).includes("/") ? intentOfJournalTask(task_id) : task_id;
			if (!intentTaskId) {
				throw new Error(
					`задача журнала ${task_id} не связана с намерением (в TaskDrafted нет intent_task_id)`,
				);
			}
			const found = await lookupIntent(intentTaskId);
			if (found.unsupported) return "облако не поддерживает состояние намерений — обнови облако";
			if (found.offline) return "синк не настроен — состояние намерения узнать не у кого (connect)";
			if (found.missing) return `намерение ${intentTaskId} не найдено в облаке`;
			if (!found.view) {
				return `состояние намерения ${intentTaskId} не проверено: облако недоступно (${found.unavailable}), кэша нет`;
			}
			const text = formatIntentStatus(found.view, {
				seen: seenOf(found.cached),
				cachedAt: found.target ? null : found.cached?.fetched_at,
			});
			if (found.target) {
				writeIntentView(db, { targetUrl: found.target.url, view: found.view, markSeen: true });
			}
			return text;
		},
	},
	{
		name: "release_intent",
		description:
			"Отпустить взятое намерение обратно в инбокс облака. Нельзя, пока по нему есть живые попытки " +
			"в журнале (DELEGATED / REPORTED / REWORK) — сначала mark_failed. Черновик не мешает: облако " +
			"отсекает прежние попытки. note — причина, её увидит команда.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Id намерения облака" },
				note: { type: "string", description: "Причина (необязательно)" },
			},
			required: ["task_id"],
		},
		handler: async ({ task_id, note }) => {
			const attempts = db
				.prepare(
					`SELECT t.task_id, t.status FROM tasks t
					 WHERE EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.task_id AND e.type = 'TaskDrafted'
					               AND json_extract(e.payload, '$.intent_task_id') = ?)
					 ORDER BY t.task_id`,
				)
				.all(task_id);
			const live = attempts.filter((row) =>
				["DELEGATED", "REPORTED", "REWORK"].includes(row.status),
			);
			if (live.length > 0) {
				throw new Error(
					`нельзя отпустить намерение ${task_id}: есть живые попытки в журнале — ${live.map((row) => `${row.task_id} (${row.status})`).join(", ")}. Сначала закрой их: mark_failed { task_id, reason }.`,
				);
			}
			const targets = orderedTargets(readIntentCache(db, task_id)?.target_url);
			if (targets.length === 0) return "синк не настроен (нет sync.json)";
			const errors = [];
			for (const target of targets) {
				const result = await postIntentRelease({
					target,
					intentTaskId: task_id,
					note: note ?? null,
					timeoutMs: INTENT_TIMEOUT,
				});
				if (result.kind === "ok") {
					const intent = result.body?.intent;
					if (intent?.id)
						writeIntentView(db, { targetUrl: target.url, view: intent, markSeen: false });
					const drafts = attempts.filter((row) => row.status === "DRAFT");
					const tail =
						drafts.length > 0
							? `\nчерновик ${drafts.map((row) => row.task_id).join(", ")} остаётся в журнале — облако считает его историей`
							: "";
					return `намерение «${intent?.title ?? task_id}» отпущено в инбокс${tail}`;
				}
				if (result.kind === "rejected" || result.kind === "forbidden") {
					return formatReleaseRejection(task_id, result);
				}
				if (result.kind === "unsupported") {
					markIntentsUnsupported();
					return "облако не поддерживает release_intent (старая версия сервера)";
				}
				if (result.kind === "unavailable") errors.push(result.error);
			}
			return errors.length > 0
				? `ошибка release_intent: ${errors.join("; ")}`
				: `намерение ${task_id} не найдено в облаке`;
		},
	},
	{
		name: "get_policy",
		description:
			"Эффективная политика проекта: правила постановки, отчёта и приёмки (enforce + guidance " +
			"по актам draft/delegate/report/accept) и откуда она взята — пространство, проект, default или lenient.",
		inputSchema: {
			type: "object",
			properties: { project: { type: "string" } },
			required: ["project"],
		},
		handler: ({ project }) => policyForProject(requireProject(project)),
	},
	{
		name: "set_policy",
		description:
			"Задать локальную политику: без project — default для всех локальных проектов, с project — " +
			"для одного. Тело — целиком (schemaVersion, name, enforce, guidance). Для проекта, привязанного " +
			"к пространству облака, отказ: его политика правится в настройках пространства.",
		inputSchema: {
			type: "object",
			properties: {
				project: { type: "string", description: "Имя проекта; пусто — default" },
				policy: { type: "object", description: "Тело политики (см. get_policy)" },
			},
			required: ["policy"],
		},
		handler: ({ project, policy }) => {
			const errors = validatePolicyBody(policy);
			if (errors.length > 0) throw new Error(`политика невалидна:\n- ${errors.join("\n- ")}`);
			const body = normalizePolicyBody(policy);
			const file = readPolicy();
			let written = "default";
			if (project) {
				const row = requireProject(project);
				if (row.cloud_workspace_id) {
					throw new Error(
						`проект "${project}" привязан к пространству ${row.cloud_workspace_id} — его политика правится в настройках пространства, локально не переопределяется`,
					);
				}
				file.projects[project] = body;
				written = `project:${project}`;
			} else {
				file.default = body;
			}
			const path = writePolicyFile({ dbPath: DB_PATH, file });
			return { written, path };
		},
	},
	{
		name: "get_task",
		description:
			"Состояние задачи, хронология событий (тип и время), связи и артефакты. Задание, отчёт и payload событий — только с full: true.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				full: { type: "boolean", description: "true — задание, отчёт и payload событий целиком" },
			},
			required: ["task_id"],
		},
		handler: async ({ task_id, full = false }) => {
			const task = getTaskStmt.get(task_id);
			if (!task) throw new Error(`Задача ${task_id} не найдена`);
			const events = db
				.prepare("SELECT seq, type, payload, at FROM events WHERE task_id = ? ORDER BY seq")
				.all(task_id);
			const links = {
				outgoing: db
					.prepare("SELECT to_task, kind FROM task_links WHERE from_task = ?")
					.all(task_id),
				incoming: db
					.prepare("SELECT from_task, kind FROM task_links WHERE to_task = ?")
					.all(task_id),
			};
			const artifacts = db
				.prepare("SELECT id, kind, title, at FROM artifacts WHERE task_id = ?")
				.all(task_id);
			const intentTaskId = intentOfJournalTask(task_id);
			const intent = intentTaskId ? await summarizeIntent(intentTaskId) : null;
			const extra = intent ? { intent } : {};
			if (full) return { task, events, links, artifacts, ...extra };
			return {
				task: compactTask(task),
				events: events.map(({ seq, type, at }) => ({ seq, type, at })),
				links,
				artifacts,
				...extra,
			};
		},
	},
	{
		name: "list_tasks",
		description: "Список задач журнала с фильтрами по статусу/проекту.",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "string",
					description: "DRAFT | DELEGATED | REPORTED | ACCEPTED | REWORK | FAILED",
				},
				project: { type: "string" },
				limit: { type: "number", description: "default 20" },
			},
		},
		handler: ({ status, project, limit = 20 }) => {
			const cond = [];
			const args = [];
			if (status) {
				cond.push("status = ?");
				args.push(status);
			}
			if (project) {
				cond.push("project = ?");
				args.push(project);
			}
			const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
			return db
				.prepare(
					`SELECT task_id, project, title, status, outcome, executor, updated_at
					 FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`,
				)
				.all(...args, limit);
		},
	},
];

// ============ инструкция сервера и промпты (слеш-команды) ============

const PROTOCOL_INSTRUCTIONS = `Журнал задач для AI-агентов (event sourcing поверх SQLite).
Статусы: DRAFT → DELEGATED → REPORTED → ACCEPTED | REWORK (→ DELEGATED…) | FAILED.
Семантика: REPORTED — заявка исполнителя «считаю, что готово»; ACCEPTED — подтверждено проверкой. Это разные факты: заявленное не выдаётся за сделанное.
Проекты регистрируются в реестре (register_project: имя-неймспейс + root_path + маппинг на пространство в облаке); задачи и артефакты принимаются только для зарегистрированных.
Артефакты (spec/plan/adr/decision/note/doc) версионируются: повторная запись с тем же title = новая версия.
Продолжение закрытой задачи — новая задача + link_tasks kind=continues; найденная по ходу работа — новая задача + discovered_from. Rework-цикл живёт только внутри незакрытой задачи.
Статусы меняются только через события журнала (инструменты), не через базу.
Намерения облака: inbox → take → draft_task с intent_task_id. Человек может отменить, закрыть или забрать намерение и поменять критерии — сервер откажет в акте и скажет почему; intent_status показывает состояние, release_intent отпускает взятое.`;

// Инструкции собираются на каждом initialize: политика и предупреждения — по
// текущему состоянию файла и базы, а не по снимку старта.
function buildInstructions() {
	const file = readPolicy();
	const lines = [
		PROTOCOL_INSTRUCTIONS,
		`Правила работы задаёт политика проекта — get_policy { project }; краткая версия встроена в описания инструментов (сейчас: «${pickStartupPolicy(file).name}»).`,
	];
	const cloudProjects = db
		.prepare("SELECT name, cloud_workspace_id FROM projects WHERE cloud_workspace_id IS NOT NULL")
		.all();
	const missing = cloudProjects.filter((p) => !file.workspaces[p.cloud_workspace_id]?.body);
	if (missing.length > 0) {
		lines.push(
			`Внимание: политика пространства не загружена для проектов ${missing.map((p) => `"${p.name}"`).join(", ")} — действуют нейтральные правила (проверь connect / sync).`,
		);
	}
	const noPolicyAtAll =
		!file.default &&
		Object.keys(file.projects).length === 0 &&
		Object.keys(file.workspaces).length === 0;
	if (noPolicyAtAll) {
		const { n } = db
			.prepare("SELECT count(*) AS n FROM artifacts WHERE title LIKE 'Project baseline: %'")
			.get();
		if (n > 0) {
			lines.push(
				"Внимание: политика не задана, а в журнале есть артефакты «Project baseline: …» — похоже, проекты велись по строгой дисциплине. Задай политику через set_policy или в настройках пространства.",
			);
		}
	}
	return lines.join("\n");
}

const PROMPTS = [
	{
		name: "tasks",
		description: "Показать журнал делегирования: задачи, поиск, инциденты",
		arguments: [
			{
				name: "filter",
				description:
					"Пусто = последние задачи; статус / проект / task_id / 'incidents' / ключевые слова",
				required: false,
			},
		],
		build: ({ filter = "" }) => `Покажи журнал делегирования Actari (инструменты mcp__actari__*).

Фильтр: "${filter}"

Разбор фильтра: пусто — list_tasks (последние 20); статус (DRAFT/DELEGATED/REPORTED/ACCEPTED/REWORK/FAILED, регистр не важен) — list_tasks по статусу; имя проекта — list_tasks по проекту (комбинируются); "incidents" — search_precedents/база: последние грабли (description + lesson); значение с "/" — get_task: карточка + история событий; иные слова — search_precedents.

Вывод: компактная таблица task_id | статус | исполнитель | outcome | обновлено (для карточки — поля + хронология). Пусто — так и сказать, без лишнего текста.`,
	},
	{
		name: "bootstrap",
		description:
			"Собрать артефакт, который политика проекта требует до постановки задач (get_policy → enforce.draft_requires_artifact)",
		arguments: [
			{
				name: "project",
				description: "Имя проекта (пусто — определить по текущему каталогу)",
				required: false,
			},
		],
		build: ({
			project = "",
		}) => `Собери артефакт, который политика проекта требует до постановки задач.

Проект: "${project}" (если пусто — определи по текущему каталогу / git remote).

Шаг 0: проект должен быть в реестре — list_projects; нет — register_project (имя-неймспейс, root_path = корень проекта на диске).
Шаг 1: get_policy { project } → enforce.draft_requires_artifact. Пусто — политика артефакта не требует: доложи и остановись.
Шаг 2: list_artifacts { project, kind: "spec" } — есть артефакт с этим заголовком и он актуален → доложи и обнови только устаревшее (record_artifact с тем же title = новая версия).
Шаг 3: нет — собери фактами, не предположениями. Что именно должно быть внутри, подсказывает guidance.draft той же политики. Зафиксируй ОДНИМ артефактом: record_artifact kind=spec, title — точно как требует политика, body — markdown.`,
	},
];

// ============ фоновый опрос намерений (спека 2026-09-14 §9.4) ============
// Только по намерениям, которые эта машина уже видела (кэш): изменения
// кладутся в очередь уведомлений и приходят в ответе следующего инструмента.

let pollInFlight = false;

async function pollIntentChanges() {
	if (intentsUnsupported || pollInFlight) return;
	const known = new Set(
		db
			.prepare("SELECT intent_task_id FROM intent_cache")
			.all()
			.map((row) => row.intent_task_id),
	);
	if (known.size === 0) return;
	pollInFlight = true;
	try {
		const pageSize = Number(readEnv("CHANGES_PAGE")) || CHANGES_PAGE;
		for (const target of usableTargets()) {
			const key = `changes_since:${target.url}`;
			let since = readIntentMeta(db, key) ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
			for (let page = 0; page < 10; page++) {
				const result = await fetchIntentChanges({ target, since, timeoutMs: INTENT_TIMEOUT });
				if (result.kind === "unsupported") {
					markIntentsUnsupported();
					return;
				}
				if (result.kind !== "ok") break;
				for (const view of result.items) {
					if (!known.has(view.id)) continue;
					const cached = readIntentCache(db, view.id);
					pushNotice(describeIntentChange(view, cached?.view ?? null));
					writeIntentView(db, { targetUrl: target.url, view, markSeen: false });
				}
				if (result.items.length >= pageSize) {
					const lastAt = Date.parse(result.items.at(-1)?.intentUpdatedAt);
					if (Number.isNaN(lastAt)) break;
					// Перекрытие в 1 мс, но только вперёд: страница из одинаковых
					// intentUpdatedAt вернула бы саму себя (облако фильтрует gt). Тогда
					// шаг на lastAt — хвост этой группы сверх страницы теряется, это
					// лучше вечного повтора одной страницы.
					const overlap = lastAt - 1;
					const nextSince = new Date(overlap > Date.parse(since) ? overlap : lastAt).toISOString();
					if (nextSince === since) break;
					since = nextSince;
					writeIntentMeta(db, key, since);
					continue;
				}
				// Курсор с перекрытием в секунду: одинаковые состояния отсекает
				// describeIntentChange по intentUpdatedAt, пропуски хуже дублей.
				const serverTime = Date.parse(result.serverTime);
				if (!Number.isNaN(serverTime)) {
					writeIntentMeta(db, key, new Date(serverTime - 1000).toISOString());
				}
				break;
			}
		}
	} finally {
		pollInFlight = false;
	}
}

setInterval(() => {
	pollIntentChanges().catch((err) => {
		console.error(`actari: опрос намерений не прошёл: ${err.message}`);
	});
}, INTENT_POLL).unref();

// ============ JSON-RPC поверх stdio (newline-delimited) ============

function respond(id, result) {
	if (id === undefined || id === null) return;
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, message, code = -32000) {
	if (id === undefined || id === null) return;
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(msg) {
	const { id, method, params } = msg;
	try {
		if (method === "initialize") {
			respond(id, {
				protocolVersion: params?.protocolVersion ?? "2024-11-05",
				capabilities: { tools: {}, prompts: {} },
				serverInfo: { name: "actari", version: PACKAGE_VERSION },
				instructions: buildInstructions(),
			});
		} else if (method === "prompts/list") {
			respond(id, {
				prompts: PROMPTS.map(({ name, description, arguments: args }) => ({
					name,
					description,
					arguments: args,
				})),
			});
		} else if (method === "prompts/get") {
			const prompt = PROMPTS.find((p) => p.name === params?.name);
			if (!prompt) throw new Error(`Неизвестный промпт: ${params?.name}`);
			respond(id, {
				description: prompt.description,
				messages: [
					{
						role: "user",
						content: { type: "text", text: prompt.build(params?.arguments ?? {}) },
					},
				],
			});
		} else if (method === "notifications/initialized") {
			// notification — ответа не требует
		} else if (method === "ping") {
			respond(id, {});
		} else if (method === "tools/list") {
			respond(id, {
				tools: TOOLS.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			});
		} else if (method === "tools/call") {
			const tool = TOOLS.find((t) => t.name === params?.name);
			if (!tool) throw new Error(`Неизвестный инструмент: ${params?.name}`);
			// Promise.resolve поддерживает и синхронные, и async-хендлеры (sync).
			// Строковый результат — готовый текст ответа, объект — JSON.
			Promise.resolve()
				.then(() => tool.handler(params?.arguments ?? {}))
				.then((result) => {
					const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
					respond(id, { content: contentWithNotices(text) });
				})
				.catch((err) => {
					respond(id, {
						content: contentWithNotices(`Ошибка: ${err.message}`),
						isError: true,
					});
				});
		} else {
			respondError(id, `Unsupported method: ${method}`, -32601);
		}
	} catch (err) {
		respondError(id, err instanceof Error ? err.message : String(err));
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const nl = buffer.indexOf("\n");
		if (nl === -1) break;
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch {
			console.error("actari: непарсимая строка входа");
		}
	}
});
process.stdin.on("end", () => process.exit(0));
