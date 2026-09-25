// Петля намерений на стороне локального сервера (спека 2026-09-14 §9).
// Здесь — всё, что не требует процесса сервера: клиент облачного API
// намерений, кэш в служебных таблицах SQLite (не события: журнал не
// меняется), решения «пропустить / отказать» и тексты для агента.
// Облако не пишет в журнал — отказывает локальный сервер, узнав решение человека.

import { normalizeBaseUrl } from "./sync.mjs";

export const INTENTS_PATH = "/api/mcp/intents";
export const INTENT_TIMEOUT_MS = 2000;
export const INTENT_POLL_MS = 60_000;
// Совпадает с CHANGE_LIMIT облака (packages/core listChanges).
export const CHANGES_PAGE = 100;

// Служебные таблицы кэша — не события: журнал они не меняют, после
// переигрывания схемы создаются заново (это только кэш).
export const INTENT_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS intent_cache (
    intent_task_id        TEXT PRIMARY KEY,
    target_url            TEXT NOT NULL,
    workspace_id          TEXT NOT NULL,
    state_json            TEXT NOT NULL,
    seen_criteria_version INTEGER NOT NULL,
    seen_criteria         TEXT,
    fetched_at            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intent_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export const UNSUPPORTED_NOTICE =
	"облако не поддерживает состояние намерений (старая версия сервера) — проверки намерений выключены до перезапуска";

export const PRIORITY_LABELS = {
	URGENT: "срочно",
	HIGH: "высокий",
	MEDIUM: "средний",
	LOW: "низкий",
	NONE: "без приоритета",
};

export const INTENT_STATE_LABELS = {
	proposed: "предложено",
	taken: "взято",
	in_progress: "в работе",
	reported_unverified: "отчёт не проверен",
	done: "сделано",
	failed: "провалено",
	done_manual: "сделано вручную",
	cancelled: "отменено",
};

const JOURNAL_LABELS = {
	untouched: "не начато",
	in_progress: "в работе",
	reported_unverified: "отчёт не проверен",
	done: "принято",
	failed: "провалено",
};

export const INTERVENTION_LABELS = {
	TAKE: "взято",
	RELEASE: "отпущено в инбокс",
	RETURN_TO_INBOX: "возвращено в инбокс",
	CANCEL: "отменено",
	DONE_MANUAL: "закрыто вручную",
	CLEAR_OVERRIDE: "ручное решение снято",
	CRITERIA_CHANGED: "критерии изменены",
	ASSIGNEE_CHANGED: "исполнитель изменён",
	PRIORITY_CHANGED: "приоритет изменён",
};

// ============ время и критерии ============

// События журнала пишут время SQLite «YYYY-MM-DD HH:MM:SS» в UTC.
export function parseJournalAt(value) {
	if (!value) return null;
	const text = String(value);
	const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

// Вывод в UTC: у агента и у человека в облаке могут быть разные пояса.
export function formatWhen(value) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "время неизвестно";
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function criteriaLines(text) {
	return String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function pluralCriteria(count) {
	if (count === 0) return "без критериев";
	const mod10 = count % 10;
	const mod100 = count % 100;
	const word =
		mod10 === 1 && mod100 !== 11
			? "критерий"
			: mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
				? "критерия"
				: "критериев";
	return `${count} ${word}`;
}

export function diffCriteria(previous, next) {
	const before = criteriaLines(previous);
	const after = criteriaLines(next);
	const lines = [
		...before.filter((line) => !after.includes(line)).map((line) => `  − ${line}`),
		...after.filter((line) => !before.includes(line)).map((line) => `  + ${line}`),
	];
	return lines.length > 0
		? lines.join("\n")
		: "  (набор строк тот же, изменился порядок или пробелы)";
}

function personName(person, fallback) {
	return person?.name?.trim() || fallback;
}

// «Лид, 2026-09-14 10:05 UTC: «комментарий»» — для ручного решения и вмешательства.
function byLine(entry) {
	const when = entry?.at ? `, ${formatWhen(entry.at)}` : "";
	const note = entry?.note ? `: «${entry.note}»` : "";
	return `${personName(entry?.by, "человек")}${when}${note}`;
}

const priorityLabel = (value) => PRIORITY_LABELS[value] ?? value;

const REOPEN_CLOCK_SLACK_MS = 5 * 60 * 1000;

function reopenedAfterAttempt({ view, seenReopenedAt, localCreatedAt }) {
	if (seenReopenedAt !== null && seenReopenedAt !== undefined) {
		return (view.reopenedAt ?? "") !== seenReopenedAt;
	}
	const reopenedAt = view.reopenedAt ? new Date(view.reopenedAt) : null;
	return (
		reopenedAt !== null &&
		localCreatedAt !== null &&
		reopenedAt.getTime() > localCreatedAt.getTime() + REOPEN_CLOCK_SLACK_MS
	);
}

function gateExitHint(localStatus, { draftContinuation, markFailedReason }) {
	if (localStatus === "DRAFT") {
		return `Не делегируй эту задачу: черновик остаётся в журнале как история. ${draftContinuation} Или закрой черновик drop_task с причиной.`;
	}
	return `Закрой попытку: mark_failed { task_id, reason: "${markFailedReason}" }.`;
}

// ============ решение перед записью события ============

export function decideIntentGate({
	act,
	view,
	seen = null,
	seenReopenedAt = null,
	localStatus = null,
	localCreatedAt = null,
}) {
	const notices = [];
	const name = `«${view.title}» (${view.id})`;

	if (view.override?.kind === "CANCELLED") {
		return {
			block: `намерение ${name} отменено в облаке — ${byLine(view.override)}. ${gateExitHint(localStatus, { draftContinuation: "Работа по намерению не нужна.", markFailedReason: "отменено человеком: <причина>" })}`,
			notices,
		};
	}
	if (view.override?.kind === "DONE_MANUAL") {
		return {
			block: `намерение ${name} закрыто человеком вручную — ${byLine(view.override)}. ${gateExitHint(localStatus, { draftContinuation: "Работа по намерению не нужна.", markFailedReason: "закрыто человеком вручную: <причина>" })}`,
			notices,
		};
	}

	if (act === "draft") {
		if (view.intentState !== "TAKEN" || !view.isMine) {
			const holder =
				view.intentState === "TAKEN" && view.takenBy
					? ` (взял ${personName(view.takenBy, "другой участник")})`
					: "";
			return {
				block: `намерение ${name} не взято тобой${holder} — сначала take { task_id: "${view.id}" }.`,
				notices,
			};
		}
	} else {
		const returnedAfter = reopenedAfterAttempt({ view, seenReopenedAt, localCreatedAt });
		if (
			!view.isMine &&
			view.intentState === "PROPOSED" &&
			!view.takenBy &&
			!returnedAfter &&
			!view.reopenedAt
		) {
			return {
				block: `намерение ${name} не взято — сначала take { task_id: "${view.id}" }, затем повтори.`,
				notices,
			};
		}
		if (!view.isMine || returnedAfter) {
			const why =
				!view.isMine && view.intentState === "TAKEN" && view.takenBy
					? `его взял ${personName(view.takenBy, "другой участник")}`
					: "возвращено в инбокс";
			const last = view.lastIntervention ? ` — ${byLine(view.lastIntervention)}` : "";
			return {
				block: `намерение ${name} больше не твоё: ${why}${last}. ${gateExitHint(localStatus, { draftContinuation: `Если намерение снова твоё — заведи новую задачу: take { task_id: "${view.id}" } → draft_task с другим slug.`, markFailedReason: "намерение забрано: <причина>" })}`,
				notices,
			};
		}
	}

	if (seen && view.criteriaVersion > seen.criteriaVersion) {
		const change = `критерии приёмки ${name} изменились (версия ${seen.criteriaVersion} → ${view.criteriaVersion}):\n${diffCriteria(seen.criteria, view.acceptanceCriteria)}`;
		if (act === "accept") {
			return {
				block: `${change}\nСверься с новыми критериями: intent_status { task_id: "${view.id}" } — после этого accept пройдёт.`,
				notices,
			};
		}
		notices.push(change);
	}

	if (seen?.priority && view.priority && view.priority !== seen.priority) {
		notices.push(
			`приоритет ${name}: ${priorityLabel(seen.priority)} → ${priorityLabel(view.priority)}`,
		);
	}

	return { block: null, notices };
}

// ============ тексты ============

export function formatInboxItem(item, projects) {
	const priority =
		item.priority && item.priority !== "NONE" ? ` [${priorityLabel(item.priority)}]` : "";
	const owner = item.isMine ? "моя" : "свободная";
	const criteria = pluralCriteria(criteriaLines(item.acceptanceCriteria).length);
	const project = projects.length === 0 ? "не привязан (sync_scope)" : projects.join(" | ");
	return (
		`- ${item.id}${priority} ${item.title} — ${owner} · ${criteria}\n` +
		`  фича: ${item.feature?.title ?? "?"} · пространство: ${item.workspace?.slug ?? "?"} · проект журнала: ${project}`
	);
}

export function formatTakeContext({ alreadyTaken, context }, projects) {
	const feature = context.feature ?? {};
	const slug = context.workspace?.slug ?? "?";
	const criteria = criteriaLines(context.acceptanceCriteria);
	const projectLine =
		projects.length === 1
			? `Проект журнала: ${projects[0]} (привязан к пространству ${slug})`
			: projects.length > 1
				? `Проекты журнала этого пространства: ${projects.join(", ")} — выбери подходящий`
				: `Проект журнала не привязан к пространству ${slug}: sync_scope { workspace: "${slug}", projects: ["<проект>"] }`;
	const draftProject = projects.length === 1 ? `project: "${projects[0]}", ` : "project, ";
	return [
		alreadyTaken
			? "Намерение уже было забрано ранее — повторная выдача контекста (take идемпотентен)."
			: "Намерение забрано из инбокса.",
		"",
		`intent_task_id: ${context.id}`,
		`Пространство: ${slug}`,
		...(context.priority && context.priority !== "NONE"
			? [`Приоритет: ${priorityLabel(context.priority)}`]
			: []),
		...(context.assignee ? [`Исполнитель: ${personName(context.assignee, "?")}`] : []),
		projectLine,
		"",
		`## Контекст фичи: ${feature.title ?? "?"}`,
		feature.description ?? "(описание фичи отсутствует)",
		...(feature.clarifications ? ["", `Уточнения: ${feature.clarifications}`] : []),
		"",
		`## Намерение: ${context.title}`,
		context.description ?? "(описания нет — уточни постановку сам)",
		"",
		criteria.length > 0
			? `## Критерии приёмки (версия ${context.criteriaVersion ?? 1})`
			: "## Критерии приёмки",
		...(criteria.length > 0
			? criteria
			: ["(критериев нет — сформулируй проверяемые сам и вынеси их в task_text)"]),
		"",
		`Рекомендованный slug: ${context.recommendedSlug}`,
		"",
		`Дальше: search_precedents по теме → draft_task с intent_task_id: "${context.id}" (${draftProject}slug, title, полный task_text по правилам журнала; критерии приёмки — дословно в task_text) → delegate → обычный цикл. evidence при accept ссылается на критерии.`,
	].join("\n");
}

export function formatTakeRejection(taskId, body) {
	const name = body?.intent?.title ? `«${body.intent.title}»` : taskId;
	switch (body?.reason) {
		case "assigned_to_other":
			return `не взято: намерение ${name} назначено на ${personName(body.by, "другого участника")}`;
		case "taken_by_other":
			return `не взято: намерение ${name} уже взял ${personName(body.by, "другой участник")}${body.at ? ` (${formatWhen(body.at)})` : ""}`;
		case "overridden":
			return `не взято: намерение ${name} ${body.override === "DONE_MANUAL" ? "закрыто вручную" : "отменено"} — ${byLine(body)}`;
		case "feature_not_in_progress":
			return `не взято: фича намерения ${name} не в работе (статус ${body.featureStatus})`;
		default:
			return `не взято: намерение ${name} — ${body?.reason ?? "облако отказало"}`;
	}
}

export function formatReleaseRejection(taskId, result) {
	if (result?.kind === "forbidden") {
		return "не отпущено: намерение из пространства, где ты не участник";
	}
	const reason = result?.body?.reason;
	switch (reason) {
		case "not_taken_by_you":
		case "taken_by_other":
			return `не отпущено: намерение ${taskId} взято не тобой`;
		case "overridden":
			return `не отпущено: намерение ${taskId} закрыто человеком (отменено или сделано вручную) — отпускать нечего`;
		case "already_in_state":
			return `не отпущено: намерение ${taskId} уже в инбоксе`;
		case "conflict":
			return `не отпущено: намерение ${taskId} облако не успело применить (одновременное изменение) — повтори`;
		default:
			return `не отпущено: ${reason ?? "облако отказало"}`;
	}
}

export function formatIntentStatus(view, { seen = null, cachedAt = null } = {}) {
	const lines = [];
	if (cachedAt) lines.push(`(облако недоступно — по кэшу на ${formatWhen(cachedAt)})`);
	lines.push(`Намерение «${view.title}» (${view.id})`);
	const journal = view.derived?.journal
		? ` · журнал: ${JOURNAL_LABELS[view.derived.journal] ?? view.derived.journal}`
		: "";
	lines.push(
		`Состояние: ${INTENT_STATE_LABELS[view.derived?.state] ?? view.derived?.state ?? "?"}${journal}`,
	);
	if (view.override) {
		lines.push(
			`Ручное решение: ${view.override.kind === "DONE_MANUAL" ? "сделано вручную" : "отменено"} — ${byLine(view.override)}`,
		);
	}
	lines.push(`Пространство: ${view.workspace?.slug ?? "?"} · фича: ${view.feature?.title ?? "?"}`);
	const taker = view.takenBy
		? `${personName(view.takenBy, "?")}${view.isMine ? " (это ты)" : ""}`
		: "никто";
	lines.push(`Исполнитель: ${personName(view.assignee, "не назначен")} · взял: ${taker}`);
	lines.push(`Приоритет: ${priorityLabel(view.priority)}`);
	const criteria = criteriaLines(view.acceptanceCriteria);
	lines.push(`Критерии приёмки (версия ${view.criteriaVersion}):`);
	lines.push(...(criteria.length > 0 ? criteria : ["(критериев нет)"]));
	if (seen && view.criteriaVersion > seen.criteriaVersion) {
		lines.push(
			`Изменения с прошлого просмотра (версия ${seen.criteriaVersion} → ${view.criteriaVersion}):`,
			diffCriteria(seen.criteria, view.acceptanceCriteria),
		);
	}
	if (view.lastIntervention) {
		lines.push(
			`Последнее вмешательство: ${INTERVENTION_LABELS[view.lastIntervention.kind] ?? view.lastIntervention.kind} — ${byLine(view.lastIntervention)}`,
		);
	}
	return lines.join("\n");
}

export function describeIntentChange(view, previous) {
	if (previous && previous.intentUpdatedAt === view.intentUpdatedAt) return null;
	const parts = [];
	if (view.lastIntervention) {
		parts.push(
			`${INTERVENTION_LABELS[view.lastIntervention.kind] ?? view.lastIntervention.kind} — ${byLine(view.lastIntervention)}`,
		);
	}
	if (previous?.isMine && !view.isMine) parts.push("намерение больше не твоё");
	if (previous && view.criteriaVersion > previous.criteriaVersion) {
		parts.push(
			`критерии изменились (версия ${view.criteriaVersion}) — intent_status покажет разницу`,
		);
	}
	if (previous && previous.priority !== view.priority) {
		parts.push(`приоритет: ${priorityLabel(previous.priority)} → ${priorityLabel(view.priority)}`);
	}
	if (parts.length === 0) return null;
	return `«${view.title}» (${view.id}): ${parts.join("; ")}`;
}

export function formatSyncWarning(warning, journalTaskId) {
	if (warning?.code !== "intent_not_found") {
		return `синк: предупреждение облака ${JSON.stringify(warning)}`;
	}
	const task = journalTaskId ?? `seq ${warning.seq}`;
	const where = warning.workspace ? `в пространстве ${warning.workspace}` : "в облаке";
	return `синк: задача ${task} ссылается на намерение ${warning.intentTaskId}, которого нет ${where} — связь с доской не создана; проверь проект задачи и sync_scope`;
}

export function formatNotices(lines) {
	return `Изменения по твоим намерениям:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

// ============ URL API намерений ============

export function intentUrlFromBase(base, intentId) {
	return `${normalizeBaseUrl(base)}${INTENTS_PATH}/${encodeURIComponent(intentId)}`;
}

export function intentReleaseUrlFromBase(base, intentId) {
	return `${intentUrlFromBase(base, intentId)}/release`;
}

export function intentChangesUrlFromBase(base, since) {
	const url = new URL(`${normalizeBaseUrl(base)}${INTENTS_PATH}/changes`);
	url.searchParams.set("since", since);
	return url.toString();
}

export function intentsUrlFromBase(base) {
	return `${normalizeBaseUrl(base)}${INTENTS_PATH}`;
}

// ============ клиент API намерений ============

function authHeaders(target, extra = {}) {
	return { authorization: `Bearer ${target.token}`, "cache-control": "no-store", ...extra };
}

async function readJson(res) {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function networkError(err) {
	return err?.cause?.code ?? err?.message ?? String(err);
}

// 404 с телом роута — намерения нет; любой другой 404 — маршрута нет вовсе.
function notFoundKind(body) {
	return body?.error === "Intent not found" ? { kind: "not_found" } : { kind: "unsupported" };
}

export async function fetchIntent({ target, intentTaskId, timeoutMs = INTENT_TIMEOUT_MS }) {
	let res;
	try {
		res = await fetch(intentUrlFromBase(target.url, intentTaskId), {
			headers: authHeaders(target),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return { kind: "unavailable", error: networkError(err) };
	}
	const body = await readJson(res);
	if (res.ok && body && typeof body.id === "string") return { kind: "ok", view: body };
	if (res.status === 404) return notFoundKind(body);
	if (res.status === 403) return { kind: "forbidden" };
	return { kind: "unavailable", error: `HTTP ${res.status}` };
}

export async function fetchIntentChanges({ target, since, timeoutMs = INTENT_TIMEOUT_MS }) {
	let res;
	try {
		res = await fetch(intentChangesUrlFromBase(target.url, since), {
			headers: authHeaders(target),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return { kind: "unavailable", error: networkError(err) };
	}
	const body = await readJson(res);
	if (res.ok && Array.isArray(body?.items)) {
		return { kind: "ok", items: body.items, serverTime: body.serverTime };
	}
	if (res.status === 404) return { kind: "unsupported" };
	return { kind: "unavailable", error: `HTTP ${res.status}` };
}

export async function postIntentRelease({
	target,
	intentTaskId,
	note = null,
	timeoutMs = INTENT_TIMEOUT_MS,
}) {
	let res;
	try {
		res = await fetch(intentReleaseUrlFromBase(target.url, intentTaskId), {
			method: "POST",
			headers: authHeaders(target, { "content-type": "application/json" }),
			body: JSON.stringify({ note }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return { kind: "unavailable", error: networkError(err) };
	}
	const body = await readJson(res);
	if (res.ok) return { kind: "ok", body };
	if (res.status === 409) return { kind: "rejected", body };
	if (res.status === 404) return notFoundKind(body);
	if (res.status === 403) return { kind: "forbidden" };
	return { kind: "unavailable", error: `HTTP ${res.status}` };
}

// publish_intent (спека 2026-09-25 §3–4): 404 с телом роута — нет намерения
// intentTaskId; любой другой 404 — старое облако без маршрута.
export async function postIntentPublish({ target, body, timeoutMs = INTENT_TIMEOUT_MS }) {
	let res;
	try {
		res = await fetch(intentsUrlFromBase(target.url), {
			method: "POST",
			headers: authHeaders(target, { "content-type": "application/json" }),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return { kind: "unavailable", error: networkError(err) };
	}
	const payload = await readJson(res);
	if (res.ok && typeof payload?.intentId === "string") return { kind: "ok", body: payload };
	if (res.status === 409) return { kind: "rejected", body: payload };
	if (res.status === 404) return notFoundKind(payload);
	if (res.status === 403) return { kind: "forbidden" };
	if (res.status === 400)
		return { kind: "invalid", issues: Array.isArray(payload?.issues) ? payload.issues : [] };
	return { kind: "unavailable", error: `HTTP ${res.status}` };
}

export function formatPublishResult(body) {
	return `намерение ${body.intentId} (${body.outcome}), фича ${body.featureId}, критерии v${body.criteriaVersion}\nдальше: /feature → take ${body.intentId}`;
}

export function formatPublishRejection({ project, slug }, body) {
	const intent = body?.intent?.id
		? `${body.intent.id}${body.intent.title ? ` («${body.intent.title}»)` : ""}`
		: "?";
	switch (body?.reason) {
		case "key_taken":
			return `ключ ${project}/${slug} уже занят другим намерением ${intent} — привязка не сделана`;
		case "closed_manually":
			return `карточку ${intent} закрыли вручную в облаке — новую не создаю`;
		default:
			return `облако отказало: ${body?.reason ?? "без причины"}`;
	}
}

// ============ кэш намерений ============

export function readIntentCache(db, intentTaskId) {
	const row = db.prepare("SELECT * FROM intent_cache WHERE intent_task_id = ?").get(intentTaskId);
	if (!row) return null;
	let view = null;
	try {
		view = JSON.parse(row.state_json);
	} catch {
		view = null;
	}
	return { ...row, view };
}

// Последнее известное состояние пишется всегда; «увиденные» критерии — только
// когда агент их действительно увидел (take, intent_status). Вставка без
// markSeen: версия 0, критерии не сверены на этой машине.
export function writeIntentView(db, { targetUrl, view, markSeen, now = new Date() }) {
	const seenColumns = markSeen
		? ", seen_criteria_version = excluded.seen_criteria_version, seen_criteria = excluded.seen_criteria"
		: "";
	db.prepare(
		`INSERT INTO intent_cache(intent_task_id, target_url, workspace_id, state_json, seen_criteria_version, seen_criteria, fetched_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(intent_task_id) DO UPDATE SET
		   target_url = excluded.target_url,
		   workspace_id = excluded.workspace_id,
		   state_json = excluded.state_json,
		   fetched_at = excluded.fetched_at${seenColumns}`,
	).run(
		view.id,
		targetUrl,
		view.workspace?.id ?? "",
		JSON.stringify(view),
		markSeen ? (view.criteriaVersion ?? 1) : 0,
		markSeen ? (view.acceptanceCriteria ?? null) : null,
		now.toISOString(),
	);
}

export function seenOf(cached) {
	if (!cached) return null;
	return {
		criteriaVersion: cached.seen_criteria_version,
		criteria: cached.seen_criteria,
		priority: cached.view?.priority ?? null,
	};
}

export function readIntentMeta(db, key) {
	return db.prepare("SELECT value FROM intent_meta WHERE key = ?").get(key)?.value ?? null;
}

export function writeIntentMeta(db, key, value) {
	db.prepare(
		"INSERT INTO intent_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}
