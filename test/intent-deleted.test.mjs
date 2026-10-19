// Удалённая задача или фича (спека delete-features-tasks §6): облако отвечает 409 с причиной
// task_deleted / feature_deleted, пакет журнала показывает человеческий текст в take, release,
// intent_status, publish_intent и log_time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WS, mcpEnv, startIntentCloud, startMcp } from "./support/intent-cloud.mjs";
import {
	deletedReasonText,
	fetchIntent,
	formatIntentDeleted,
	formatPublishRejection,
	formatReleaseRejection,
	formatTakeRejection,
	isDeletedReason,
	postWorkLog,
} from "../intent.mjs";

const tmpDir = () => mkdtempSync(join(tmpdir(), "actari-intent-deleted-"));

const REASONS = [
	["task_deleted", "задача удалена"],
	["feature_deleted", "фича удалена"],
];

test("тексты причин и распознавание", () => {
	assert.equal(isDeletedReason("task_deleted"), true);
	assert.equal(isDeletedReason("feature_deleted"), true);
	assert.equal(isDeletedReason("overridden"), false);
	assert.equal(deletedReasonText("task_deleted"), "задача удалена");
	assert.equal(deletedReasonText("feature_deleted"), "фича удалена");
	assert.equal(
		formatIntentDeleted("intent-1", "task_deleted"),
		"намерение intent-1: задача удалена — состояние недоступно, брать и списывать время нельзя",
	);
});

test("formatTakeRejection / formatReleaseRejection / formatPublishRejection: тексты удаления", () => {
	const intent = { id: "intent-1", title: "Эндпойнт" };
	assert.equal(
		formatTakeRejection("intent-1", { reason: "task_deleted", intent }),
		"не взято: задача удалена — намерение «Эндпойнт» больше недоступно",
	);
	assert.equal(
		formatTakeRejection("intent-1", { reason: "feature_deleted", intent }),
		"не взято: фича удалена — намерение «Эндпойнт» больше недоступно",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "task_deleted" } }),
		"не отпущено: задача удалена — намерение intent-1 больше недоступно",
	);
	assert.equal(
		formatReleaseRejection("intent-1", { kind: "rejected", body: { reason: "feature_deleted" } }),
		"не отпущено: фича удалена — намерение intent-1 больше недоступно",
	);
	const key = { project: "demo", slug: "brief-one" };
	assert.equal(
		formatPublishRejection(key, { reason: "feature_deleted", intent }),
		"фича удалена: намерение intent-1 («Эндпойнт») в облаке удалено — публикация не сделана",
	);
	assert.equal(
		formatPublishRejection(key, { reason: "task_deleted", intent }),
		"задача удалена: намерение intent-1 («Эндпойнт») в облаке удалено — публикация не сделана",
	);
});

test("fetchIntent и postWorkLog различают 409 удаления и прочие отказы", async (t) => {
	const cloud = await startIntentCloud(t, {
		intents: [{ id: "i-1" }, { id: "i-2" }],
		workLogTasks: { "i-2": { title: "X", totalMinutes: 0 } },
	});
	cloud.markDeleted("i-1", "feature_deleted");
	const target = { url: cloud.baseUrl, token: "test-mcp-token" };
	const got = await fetchIntent({ target, intentTaskId: "i-1", timeoutMs: 1000 });
	assert.equal(got.kind, "deleted");
	assert.equal(got.reason, "feature_deleted");
	assert.equal(got.view?.id, "i-1");
	const live = await fetchIntent({ target, intentTaskId: "i-2", timeoutMs: 1000 });
	assert.equal(live.kind, "ok");
	const logged = await postWorkLog({
		target,
		body: { taskId: "i-1", minutes: 30, date: "2026-10-19" },
		timeoutMs: 1000,
	});
	assert.deepEqual(logged, { kind: "deleted", reason: "feature_deleted" });
});

for (const [reason, text] of REASONS) {
	test(`take: ${reason} — отказ «${text}»`, async (t) => {
		const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
		cloud.markDeleted("intent-1", reason);
		const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
		const res = await c.tool("take", { task_id: "intent-1" });
		assert.match(res.text, new RegExp(`не взято: ${text}`));
		assert.doesNotMatch(res.text, /не найдено/);
	});

	test(`intent_status: ${reason} — «${text}», не «недоступно»`, async (t) => {
		const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
		const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
		const before = await c.tool("intent_status", { task_id: "intent-1" });
		assert.equal(before.ok, true, before.text);
		cloud.markDeleted("intent-1", reason);
		const res = await c.tool("intent_status", { task_id: "intent-1" });
		assert.match(res.text, new RegExp(`намерение intent-1: ${text}`));
		assert.doesNotMatch(res.text, /облако недоступно/);
	});

	test(`release_intent: ${reason} — «${text}»`, async (t) => {
		const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
		const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
		await c.tool("register_project", {
			name: "demo",
			root_path: "/tmp/demo",
			cloud_workspace_id: WS.id,
		});
		assert.equal((await c.tool("take", { task_id: "intent-1" })).ok, true);
		cloud.markDeleted("intent-1", reason);
		const res = await c.tool("release_intent", { task_id: "intent-1" });
		assert.match(res.text, new RegExp(`не отпущено: ${text}`));
	});

	test(`publish_intent: ${reason} — «${text}», карточку не создаём`, async (t) => {
		const cloud = await startIntentCloud(t, { intents: [{ id: "intent-1" }] });
		cloud.markDeleted("intent-1", reason);
		const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
		await c.tool("register_project", {
			name: "demo",
			root_path: "/tmp/demo",
			cloud_workspace_id: WS.id,
		});
		const res = await c.tool("publish_intent", {
			project: "demo",
			slug: "brief-one",
			title: "Бриф",
			text: "Текст",
			acceptance_criteria: "- раз",
			intent_task_id: "intent-1",
		});
		assert.equal(res.ok, false, res.text);
		assert.match(res.text, new RegExp(`${text}: намерение intent-1`));
		assert.match(res.text, /публикация не сделана/);
	});

	test(`log_time: ${reason} — «${text}», время не списано`, async (t) => {
		const cloud = await startIntentCloud(t, {
			intents: [{ id: "intent-1" }],
			workLogTasks: { "intent-1": { title: "Сделать доску", totalMinutes: 0 } },
		});
		cloud.markDeleted("intent-1", reason);
		const c = startMcp(t, mcpEnv(tmpDir(), cloud.baseUrl));
		const res = await c.tool("log_time", { task_id: "intent-1", hours: 1 });
		assert.equal(res.ok, false, res.text);
		assert.equal(res.text, `Ошибка: ${text}: intent-1 в облаке удалена — время не списано`);
		assert.doesNotMatch(res.text, /не найдена/);
	});
}
