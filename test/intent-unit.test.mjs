// Модуль намерений без сети и без процесса сервера: решения проверок
// и тексты для агента (спека 2026-09-14 §9).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

import {
	INTENT_CACHE_DDL,
	criteriaLines,
	decideIntentGate,
	describeIntentChange,
	diffCriteria,
	fetchIntent,
	fetchIntentChanges,
	formatInboxItem,
	formatIntentStatus,
	formatNotices,
	formatSyncWarning,
	formatReleaseRejection,
	formatTakeContext,
	formatTakeRejection,
	formatWhen,
	parseJournalAt,
	pluralCriteria,
	postIntentRelease,
	readIntentCache,
	readIntentMeta,
	seenOf,
	writeIntentMeta,
	writeIntentView,
} from "../intent.mjs";

const LEAD = { id: "u-lead", name: "Лид" };
const ME = { id: "u-me", name: "Алексей" };

function view(over = {}) {
	return {
		id: "intent-1",
		title: "Эндпойнт прогноза",
		workspace: { id: "ws-1", slug: "acme" },
		feature: { id: "f-1", title: "Прогноз", status: "IN_PROGRESS" },
		intentState: "TAKEN",
		override: null,
		derived: { state: "in_progress", journal: "in_progress", attempts: 1 },
		assignee: ME,
		takenBy: ME,
		isMine: true,
		reopenedAt: null,
		priority: "HIGH",
		acceptanceCriteria: "- отдаёт 7 дней\n- 502 при ошибке API",
		criteriaVersion: 2,
		intentUpdatedAt: "2026-09-14T10:00:00.000Z",
		lastIntervention: { kind: "TAKE", note: null, by: ME, at: "2026-09-14T10:00:00.000Z" },
		...over,
	};
}

const seen = {
	criteriaVersion: 2,
	criteria: "- отдаёт 7 дней\n- 502 при ошибке API",
	priority: "HIGH",
};

test("parseJournalAt и formatWhen: SQLite-время как UTC, вывод без часовых поясов машины", () => {
	assert.equal(parseJournalAt("2026-09-14 10:00:05").toISOString(), "2026-09-14T10:00:05.000Z");
	assert.equal(
		parseJournalAt("2026-09-14T10:00:05.000Z").toISOString(),
		"2026-09-14T10:00:05.000Z",
	);
	assert.equal(parseJournalAt(null), null);
	assert.equal(parseJournalAt("мусор"), null);
	assert.equal(formatWhen("2026-09-14T10:05:59.000Z"), "2026-09-14 10:05 UTC");
});

test("критерии: строки, склонение, разница по строкам", () => {
	assert.deepEqual(criteriaLines(" - a \n\n- b"), ["- a", "- b"]);
	assert.deepEqual(criteriaLines(null), []);
	assert.equal(pluralCriteria(0), "без критериев");
	assert.equal(pluralCriteria(1), "1 критерий");
	assert.equal(pluralCriteria(3), "3 критерия");
	assert.equal(pluralCriteria(5), "5 критериев");
	assert.equal(pluralCriteria(11), "11 критериев");
	assert.equal(pluralCriteria(22), "22 критерия");
	assert.equal(diffCriteria("- a\n- b", "- b\n- c"), "  − - a\n  + - c");
	assert.match(diffCriteria("- a", " - a "), /набор строк тот же/);
});

test("decideIntentGate: отмена и ручное закрытие блокируют любой акт", () => {
	const cancelled = view({
		override: { kind: "CANCELLED", note: "фича снята", by: LEAD, at: "2026-09-14T10:05:00.000Z" },
	});
	for (const act of ["draft", "delegate", "report", "accept", "rework"]) {
		const { block } = decideIntentGate({ act, view: cancelled, seen });
		assert.match(block, /отменено в облаке — Лид, 2026-09-14 10:05 UTC: «фича снята»/, act);
		assert.match(block, /mark_failed/, act);
	}
	const manual = view({
		override: { kind: "DONE_MANUAL", note: null, by: LEAD, at: "2026-09-14T10:05:00.000Z" },
	});
	assert.match(
		decideIntentGate({ act: "accept", view: manual, seen }).block,
		/закрыто человеком вручную — Лид/,
	);
});

test("decideIntentGate: draft требует take этим пользователем", () => {
	assert.match(
		decideIntentGate({
			act: "draft",
			view: view({ intentState: "PROPOSED", isMine: false, takenBy: null }),
		}).block,
		/не взято тобой — сначала take \{ task_id: "intent-1" \}/,
	);
	assert.match(
		decideIntentGate({
			act: "draft",
			view: view({ isMine: false, takenBy: { id: "u-x", name: "Ира" } }),
		}).block,
		/не взято тобой \(взял Ира\)/,
	);
	assert.deepEqual(decideIntentGate({ act: "draft", view: view(), seen }), {
		block: null,
		notices: [],
	});
});

test("decideIntentGate: намерение забрали — «больше не твоё»", () => {
	const returned = view({
		intentState: "PROPOSED",
		isMine: false,
		takenBy: null,
		reopenedAt: "2026-09-14T10:10:00.000Z",
		lastIntervention: {
			kind: "RETURN_TO_INBOX",
			note: "переделать",
			by: LEAD,
			at: "2026-09-14T10:10:00.000Z",
		},
	});
	assert.match(
		decideIntentGate({ act: "delegate", view: returned, seen }).block,
		/больше не твоё: возвращено в инбокс — Лид, 2026-09-14 10:10 UTC: «переделать»/,
	);
	const takenByOther = view({ isMine: false, takenBy: { id: "u-x", name: "Ира" } });
	assert.match(decideIntentGate({ act: "report", view: takenByOther, seen }).block, /его взял Ира/);
	// Взял снова я, но локальная попытка старше возврата — тоже не моя
	const retaken = view({ reopenedAt: "2026-09-14T10:10:00.000Z" });
	assert.match(
		decideIntentGate({
			act: "accept",
			view: retaken,
			seen,
			localCreatedAt: new Date("2026-09-14T10:00:00Z"),
		}).block,
		/больше не твоё/,
	);
	assert.equal(
		decideIntentGate({
			act: "accept",
			view: retaken,
			seen,
			localCreatedAt: new Date("2026-09-14T10:11:00Z"),
		}).block,
		null,
	);
});

test("decideIntentGate: seenReopenedAt, а не часы разных машин; допуск 5 минут", () => {
	const retaken = view({ reopenedAt: "2026-09-14T10:10:00.000Z" });
	assert.equal(
		decideIntentGate({
			act: "accept",
			view: retaken,
			seen,
			seenReopenedAt: "2026-09-14T10:10:00.000Z",
			localCreatedAt: new Date("2026-09-14T09:10:00Z"),
		}).block,
		null,
		"увиденный reopenedAt совпадает — локальные часы на час раньше не блокируют",
	);
	assert.equal(
		decideIntentGate({
			act: "accept",
			view: view({ reopenedAt: "2026-09-14T10:03:00.000Z" }),
			seen,
			seenReopenedAt: null,
			localCreatedAt: new Date("2026-09-14T10:00:00Z"),
		}).block,
		null,
		"записи нет, разница 3 минуты — допуск в пользу агента",
	);
	assert.match(
		decideIntentGate({
			act: "accept",
			view: view({ reopenedAt: "2026-09-14T10:10:00.000Z" }),
			seen,
			seenReopenedAt: null,
			localCreatedAt: new Date("2026-09-14T10:00:00Z"),
		}).block,
		/больше не твоё/,
		"записи нет, разница 10 минут — блокирует",
	);
});

test("decideIntentGate: PROPOSED без take — сначала take, без mark_failed", () => {
	const { block } = decideIntentGate({
		act: "report",
		view: view({
			intentState: "PROPOSED",
			isMine: false,
			takenBy: null,
			reopenedAt: null,
		}),
		seen,
		localStatus: "DELEGATED",
	});
	assert.match(block, /не взято — сначала take \{ task_id: "intent-1" \}/);
	assert.doesNotMatch(block, /mark_failed/);
});

test("decideIntentGate: новые критерии — accept отказ до intent_status, остальным уведомление", () => {
	const changed = view({
		acceptanceCriteria: "- отдаёт 7 дней\n- кэш 10 минут",
		criteriaVersion: 3,
	});
	const accept = decideIntentGate({ act: "accept", view: changed, seen });
	assert.match(
		accept.block,
		/критерии приёмки «Эндпойнт прогноза» \(intent-1\) изменились \(версия 2 → 3\)/,
	);
	assert.match(accept.block, /− - 502 при ошибке API/);
	assert.match(accept.block, /\+ - кэш 10 минут/);
	assert.match(accept.block, /intent_status \{ task_id: "intent-1" \}/);
	const delegate = decideIntentGate({ act: "delegate", view: changed, seen });
	assert.equal(delegate.block, null);
	assert.equal(delegate.notices.length, 1);
	assert.match(delegate.notices[0], /версия 2 → 3/);
	// Без увиденного (первое знакомство) — сравнивать не с чем
	assert.deepEqual(decideIntentGate({ act: "accept", view: changed, seen: null }), {
		block: null,
		notices: [],
	});
});

test("decideIntentGate: смена приоритета — только уведомление", () => {
	const result = decideIntentGate({ act: "report", view: view({ priority: "URGENT" }), seen });
	assert.equal(result.block, null);
	assert.deepEqual(result.notices, ["приоритет «Эндпойнт прогноза» (intent-1): высокий → срочно"]);
});

test("formatInboxItem: приоритет, владелец, критерии, проект журнала", () => {
	const item = {
		id: "intent-1",
		title: "Эндпойнт прогноза",
		priority: "URGENT",
		acceptanceCriteria: "- a\n- b",
		isMine: true,
		feature: { id: "f-1", title: "Прогноз" },
		workspace: { id: "ws-1", slug: "acme", name: "Acme" },
	};
	assert.equal(
		formatInboxItem(item, ["demo"]),
		"- intent-1 [срочно] Эндпойнт прогноза — моя · 2 критерия\n  фича: Прогноз · пространство: acme · проект журнала: demo",
	);
	assert.equal(
		formatInboxItem({ ...item, priority: "NONE", isMine: false, acceptanceCriteria: null }, []),
		"- intent-1 Эндпойнт прогноза — свободная · без критериев\n  фича: Прогноз · пространство: acme · проект журнала: не привязан (sync_scope)",
	);
});

test("formatTakeContext: критерии с версией, приоритет, исполнитель, проект и болванка draft_task", () => {
	const text = formatTakeContext(
		{
			alreadyTaken: false,
			context: {
				id: "intent-1",
				title: "Эндпойнт прогноза",
				description: "GET /forecast",
				priority: "HIGH",
				acceptanceCriteria: "- отдаёт 7 дней",
				criteriaVersion: 2,
				assignee: ME,
				feature: {
					id: "f-1",
					title: "Прогноз",
					description: "Погода на неделю",
					clarifications: "Только Москва",
				},
				workspace: { id: "ws-1", slug: "acme", name: "Acme" },
				recommendedSlug: "endpoint-prognoza",
			},
		},
		["demo"],
	);
	for (const expected of [
		/^Намерение забрано из инбокса\./,
		/intent_task_id: intent-1/,
		/Пространство: acme/,
		/Приоритет: высокий/,
		/Исполнитель: Алексей/,
		/Проект журнала: demo \(привязан к пространству acme\)/,
		/## Контекст фичи: Прогноз\nПогода на неделю/,
		/Уточнения: Только Москва/,
		/## Намерение: Эндпойнт прогноза\nGET \/forecast/,
		/## Критерии приёмки \(версия 2\)\n- отдаёт 7 дней/,
		/Рекомендованный slug: endpoint-prognoza/,
		/search_precedents по теме → draft_task с intent_task_id: "intent-1" \(project: "demo", /,
	]) {
		assert.match(text, expected);
	}
	const unbound = formatTakeContext(
		{
			alreadyTaken: true,
			context: {
				id: "intent-2",
				title: "Т",
				workspace: { id: "ws-1", slug: "acme" },
				recommendedSlug: "t",
			},
		},
		[],
	);
	assert.match(unbound, /уже было забрано ранее/);
	assert.match(
		unbound,
		/Проект журнала не привязан к пространству acme: sync_scope \{ workspace: "acme", projects: \["<проект>"\] \}/,
	);
	assert.match(unbound, /## Критерии приёмки\n\(критериев нет/);
});

test("formatTakeRejection: причины отказа облака человеческим языком", () => {
	const intent = { title: "Эндпойнт прогноза" };
	assert.equal(
		formatTakeRejection("intent-1", {
			reason: "taken_by_other",
			by: { name: "Ира" },
			at: "2026-09-14T10:00:00.000Z",
			intent,
		}),
		"не взято: намерение «Эндпойнт прогноза» уже взял Ира (2026-09-14 10:00 UTC)",
	);
	assert.equal(
		formatTakeRejection("intent-1", { reason: "assigned_to_other", by: { name: "Ира" }, intent }),
		"не взято: намерение «Эндпойнт прогноза» назначено на Ира",
	);
	assert.equal(
		formatTakeRejection("intent-1", {
			reason: "overridden",
			override: "CANCELLED",
			note: "снята",
			by: { name: "Лид" },
			at: "2026-09-14T09:00:00.000Z",
			intent,
		}),
		"не взято: намерение «Эндпойнт прогноза» отменено — Лид, 2026-09-14 09:00 UTC: «снята»",
	);
	assert.equal(
		formatTakeRejection("intent-1", {
			reason: "feature_not_in_progress",
			featureStatus: "DRAFT",
			intent,
		}),
		"не взято: фича намерения «Эндпойнт прогноза» не в работе (статус DRAFT)",
	);
	assert.equal(
		formatTakeRejection("intent-9", { reason: "conflict" }),
		"не взято: намерение intent-9 — conflict",
	);
});

test("formatReleaseRejection: 409 по reason и 403", () => {
	assert.equal(
		formatReleaseRejection("intent-1", {
			kind: "rejected",
			body: { reason: "not_taken_by_you" },
		}),
		"не отпущено: намерение intent-1 взято не тобой",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "taken_by_other" } }),
		"не отпущено: намерение intent-1 взято не тобой",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "overridden" } }),
		"не отпущено: намерение intent-1 закрыто человеком (отменено или сделано вручную) — отпускать нечего",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "already_in_state" } }),
		"не отпущено: намерение intent-1 уже в инбоксе",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "conflict" } }),
		"не отпущено: намерение intent-1 облако не успело применить (одновременное изменение) — повтори",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "note_required" } }),
		"не отпущено: note_required",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "forbidden" }),
		"не отпущено: намерение из пространства, где ты не участник",
	);
});

test("formatIntentStatus: состояние, ручное решение, критерии и разница с увиденным", () => {
	const text = formatIntentStatus(
		view({
			override: { kind: "CANCELLED", note: "снята", by: LEAD, at: "2026-09-14T10:05:00.000Z" },
			derived: { state: "cancelled", journal: "reported_unverified", attempts: 1 },
			criteriaVersion: 3,
			acceptanceCriteria: "- отдаёт 7 дней",
			lastIntervention: { kind: "CANCEL", note: "снята", by: LEAD, at: "2026-09-14T10:05:00.000Z" },
		}),
		{ seen },
	);
	for (const expected of [
		/^Намерение «Эндпойнт прогноза» \(intent-1\)/,
		/Состояние: отменено · журнал: отчёт не проверен/,
		/Ручное решение: отменено — Лид, 2026-09-14 10:05 UTC: «снята»/,
		/Пространство: acme · фича: Прогноз/,
		/Исполнитель: Алексей · взял: Алексей \(это ты\)/,
		/Приоритет: высокий/,
		/Критерии приёмки \(версия 3\):\n- отдаёт 7 дней/,
		/Изменения с прошлого просмотра \(версия 2 → 3\):\n {2}− - 502 при ошибке API/,
		/Последнее вмешательство: отменено — Лид/,
	]) {
		assert.match(text, expected);
	}
	assert.match(
		formatIntentStatus(view(), { cachedAt: "2026-09-14T09:00:00.000Z" }),
		/^\(облако недоступно — по кэшу на 2026-09-14 09:00 UTC\)/,
	);
});

test("describeIntentChange: что поменялось с прошлого известного состояния", () => {
	const previous = view();
	assert.equal(describeIntentChange(previous, previous), null);
	const cancelled = view({
		intentUpdatedAt: "2026-09-14T10:05:00.000Z",
		override: { kind: "CANCELLED", note: "снята", by: LEAD, at: "2026-09-14T10:05:00.000Z" },
		lastIntervention: { kind: "CANCEL", note: "снята", by: LEAD, at: "2026-09-14T10:05:00.000Z" },
	});
	assert.equal(
		describeIntentChange(cancelled, previous),
		"«Эндпойнт прогноза» (intent-1): отменено — Лид, 2026-09-14 10:05 UTC: «снята»",
	);
	const lost = view({
		intentUpdatedAt: "2026-09-14T10:06:00.000Z",
		isMine: false,
		criteriaVersion: 3,
		priority: "LOW",
		lastIntervention: {
			kind: "ASSIGNEE_CHANGED",
			note: null,
			by: LEAD,
			at: "2026-09-14T10:06:00.000Z",
		},
	});
	assert.equal(
		describeIntentChange(lost, previous),
		"«Эндпойнт прогноза» (intent-1): исполнитель изменён — Лид, 2026-09-14 10:06 UTC; намерение больше не твоё; критерии изменились (версия 3) — intent_status покажет разницу; приоритет: высокий → низкий",
	);
});

test("formatSyncWarning и formatNotices", () => {
	assert.equal(
		formatSyncWarning(
			{ seq: 7, code: "intent_not_found", intentTaskId: "intent-x", workspace: "acme" },
			"demo/2026-09-14-a",
		),
		"синк: задача demo/2026-09-14-a ссылается на намерение intent-x, которого нет в пространстве acme — связь с доской не создана; проверь проект задачи и sync_scope",
	);
	assert.match(
		formatSyncWarning({ seq: 7, code: "intent_not_found", intentTaskId: "intent-x" }, null),
		/задача seq 7/,
	);
	assert.equal(formatNotices(["a", "b"]), "Изменения по твоим намерениям:\n- a\n- b");
});

test("кэш намерений: вставка без markSeen не сверяет критерии, обновление — только с markSeen", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(INTENT_CACHE_DDL);
	db.exec(INTENT_CACHE_DDL); // повторный старт сервера не падает

	assert.equal(readIntentCache(db, "intent-1"), null);
	assert.equal(seenOf(null), null);

	writeIntentView(db, {
		targetUrl: "http://a",
		view: view(),
		markSeen: false,
		now: new Date("2026-09-14T10:00:00Z"),
	});
	let cached = readIntentCache(db, "intent-1");
	assert.equal(cached.target_url, "http://a");
	assert.equal(cached.workspace_id, "ws-1");
	assert.equal(cached.fetched_at, "2026-09-14T10:00:00.000Z");
	assert.deepEqual(seenOf(cached), {
		criteriaVersion: 0,
		criteria: null,
		priority: "HIGH",
	});

	writeIntentView(db, {
		targetUrl: "http://a",
		view: view(),
		markSeen: true,
		now: new Date("2026-09-14T10:00:00Z"),
	});
	assert.deepEqual(seenOf(readIntentCache(db, "intent-1")), {
		criteriaVersion: 2,
		criteria: "- отдаёт 7 дней\n- 502 при ошибке API",
		priority: "HIGH",
	});

	const changed = view({ criteriaVersion: 3, acceptanceCriteria: "- новое", priority: "LOW" });
	writeIntentView(db, { targetUrl: "http://a", view: changed, markSeen: false });
	cached = readIntentCache(db, "intent-1");
	assert.equal(cached.view.criteriaVersion, 3, "последнее состояние обновилось");
	assert.equal(cached.seen_criteria_version, 2, "увиденное — нет");
	assert.equal(seenOf(cached).priority, "LOW", "приоритет сравнивается с последним известным");

	writeIntentView(db, { targetUrl: "http://a", view: changed, markSeen: true });
	assert.equal(readIntentCache(db, "intent-1").seen_criteria_version, 3);
	assert.equal(readIntentCache(db, "intent-1").seen_criteria, "- новое");

	assert.equal(readIntentMeta(db, "changes_since:http://a"), null);
	writeIntentMeta(db, "changes_since:http://a", "2026-09-14T10:00:00.000Z");
	writeIntentMeta(db, "changes_since:http://a", "2026-09-14T10:01:00.000Z");
	assert.equal(readIntentMeta(db, "changes_since:http://a"), "2026-09-14T10:01:00.000Z");
});

test("кэш: вставка без markSeen не считает критерии увиденными; пустые критерии всё равно по версии", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(INTENT_CACHE_DDL);
	writeIntentView(db, { targetUrl: "http://a", view: view(), markSeen: false });
	const cached = readIntentCache(db, "intent-1");
	assert.equal(cached.seen_criteria_version, 0);
	assert.equal(cached.seen_criteria, null);

	const empty = view({ acceptanceCriteria: "", criteriaVersion: 1 });
	const blocked = decideIntentGate({
		act: "accept",
		view: empty,
		seen: { criteriaVersion: 0, criteria: null, priority: empty.priority },
	});
	assert.match(blocked.block, /intent_status \{ task_id: "intent-1" \}/);
});

async function startJsonServer(t, handler) {
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const reply = handler({ method: req.method, url, headers: req.headers, body });
			if (reply === "hang") return; // таймаут: ответа не будет
			res.writeHead(reply.status, {
				"content-type": reply.html ? "text/html" : "application/json",
			});
			res.end(reply.html ? "<html>404</html>" : JSON.stringify(reply.body));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	return { url: `http://127.0.0.1:${server.address().port}`, token: "tok" };
}

test("fetchIntent: ok / нет намерения / чужое / маршрута нет / недоступно / таймаут", async (t) => {
	const seenAuth = [];
	const target = await startJsonServer(t, ({ url, headers }) => {
		seenAuth.push(headers.authorization);
		const id = decodeURIComponent(url.pathname.split("/").at(-1));
		if (id === "ok") return { status: 200, body: view({ id: "ok" }) };
		if (id === "missing") return { status: 404, body: { error: "Intent not found" } };
		if (id === "foreign") return { status: 403, body: { error: "Not a member of this workspace" } };
		if (id === "old-cloud") return { status: 404, html: true };
		if (id === "boom") return { status: 500, body: { error: "boom" } };
		return "hang";
	});
	const ok = await fetchIntent({ target, intentTaskId: "ok" });
	assert.equal(ok.kind, "ok");
	assert.equal(ok.view.id, "ok");
	assert.equal(seenAuth[0], "Bearer tok");
	assert.deepEqual(await fetchIntent({ target, intentTaskId: "missing" }), { kind: "not_found" });
	assert.deepEqual(await fetchIntent({ target, intentTaskId: "foreign" }), { kind: "forbidden" });
	assert.deepEqual(await fetchIntent({ target, intentTaskId: "old-cloud" }), {
		kind: "unsupported",
	});
	assert.deepEqual(await fetchIntent({ target, intentTaskId: "boom" }), {
		kind: "unavailable",
		error: "HTTP 500",
	});
	const hung = await fetchIntent({ target, intentTaskId: "hang", timeoutMs: 100 });
	assert.equal(hung.kind, "unavailable");
});

test("fetchIntentChanges и postIntentRelease: разбор ответов", async (t) => {
	const target = await startJsonServer(t, ({ method, url, body }) => {
		if (url.pathname.endsWith("/intents/changes")) {
			assert.equal(url.searchParams.get("since"), "2026-09-14T10:00:00.000Z");
			return { status: 200, body: { items: [view()], serverTime: "2026-09-14T10:01:00.000Z" } };
		}
		assert.equal(method, "POST");
		const note = JSON.parse(body || "{}").note ?? null;
		if (url.pathname.includes("/mine/"))
			return {
				status: 200,
				body: { changed: true, intent: view({ intentState: "PROPOSED" }), note },
			};
		if (url.pathname.includes("/others/"))
			return { status: 409, body: { reason: "not_taken_by_you", intent: view() } };
		return { status: 404, body: { error: "Intent not found" } };
	});
	const changes = await fetchIntentChanges({ target, since: "2026-09-14T10:00:00.000Z" });
	assert.equal(changes.kind, "ok");
	assert.equal(changes.items.length, 1);
	assert.equal(changes.serverTime, "2026-09-14T10:01:00.000Z");

	const released = await postIntentRelease({ target, intentTaskId: "mine", note: "не успеваю" });
	assert.equal(released.kind, "ok");
	assert.equal(released.body.note, "не успеваю");
	const rejected = await postIntentRelease({ target, intentTaskId: "others", note: null });
	assert.equal(rejected.kind, "rejected");
	assert.equal(rejected.body.reason, "not_taken_by_you");
	assert.deepEqual(await postIntentRelease({ target, intentTaskId: "nope" }), {
		kind: "not_found",
	});

	const oldCloud = await startJsonServer(t, () => ({ status: 404, html: true }));
	assert.deepEqual(
		await fetchIntentChanges({ target: oldCloud, since: "2026-09-14T10:00:00.000Z" }),
		{ kind: "unsupported" },
	);
});
