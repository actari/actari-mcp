// policy.mjs — политика журнала как данные: правила движения по статусам.
// Файл policy.json рядом с базой (по образцу sync.json). Секцию workspaces
// пишет только pull из облака; default и projects — set_policy.
// Zero deps: валидация руками по той же таблице, что zod-схема в core.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readEnv } from "./env.mjs";

export const POLICY_SCHEMA_VERSION = 1;
export const POLICY_FILE = "policy.json";
export const POLICY_ACTS = Object.freeze(["draft", "delegate", "report", "accept"]);

// Нейтральная политика: журнал только записывает. Поведение без файла.
export const LENIENT_POLICY = Object.freeze({
	schemaVersion: POLICY_SCHEMA_VERSION,
	name: "Lenient",
	description: "Журнал только записывает. Правила постановки и приёмки — на усмотрение команды.",
	enforce: Object.freeze({ accept_requires_evidence: false, draft_requires_artifact: null }),
	guidance: Object.freeze({ draft: "", delegate: "", report: "", accept: "" }),
});

const LIMITS = Object.freeze({ name: 80, description: 300, artifactTitle: 120, guidance: 4000 });

// Ошибки словами, а не исключением: set_policy и импорт показывают их списком.
export function validatePolicyBody(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return ["тело политики должно быть объектом"];
	}
	const errors = [];
	if (body.schemaVersion !== POLICY_SCHEMA_VERSION) {
		errors.push(`schemaVersion: ожидается ${POLICY_SCHEMA_VERSION}`);
	}
	if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > LIMITS.name) {
		errors.push(`name: строка 1–${LIMITS.name} символов`);
	}
	if (
		body.description !== undefined &&
		(typeof body.description !== "string" || body.description.length > LIMITS.description)
	) {
		errors.push(`description: строка до ${LIMITS.description} символов`);
	}
	const enforce = body.enforce;
	if (!enforce || typeof enforce !== "object") {
		errors.push("enforce: объект обязателен");
	} else {
		if (typeof enforce.accept_requires_evidence !== "boolean") {
			errors.push("enforce.accept_requires_evidence: boolean");
		}
		const tpl = enforce.draft_requires_artifact;
		if (tpl !== null && tpl !== undefined) {
			if (typeof tpl !== "string" || tpl.length < 1 || tpl.length > LIMITS.artifactTitle) {
				errors.push(
					`enforce.draft_requires_artifact: null или строка 1–${LIMITS.artifactTitle} символов`,
				);
			} else if (!tpl.includes("{project}")) {
				errors.push("enforce.draft_requires_artifact: шаблон обязан содержать {project}");
			}
		}
	}
	const guidance = body.guidance;
	if (!guidance || typeof guidance !== "object") {
		errors.push("guidance: объект обязателен");
	} else {
		for (const act of POLICY_ACTS) {
			const text = guidance[act];
			if (typeof text !== "string") {
				errors.push(`guidance.${act}: строка обязательна (можно пустую)`);
			} else if (text.length > LIMITS.guidance) {
				errors.push(`guidance.${act}: не длиннее ${LIMITS.guidance} символов`);
			}
		}
	}
	return errors;
}

// После валидации: необязательные поля всегда присутствуют, лишние — отброшены.
export function normalizePolicyBody(body) {
	return {
		schemaVersion: POLICY_SCHEMA_VERSION,
		name: body.name,
		description: body.description ?? "",
		enforce: {
			accept_requires_evidence: body.enforce.accept_requires_evidence,
			draft_requires_artifact: body.enforce.draft_requires_artifact ?? null,
		},
		guidance: Object.fromEntries(POLICY_ACTS.map((act) => [act, body.guidance[act]])),
	};
}

export function policyConfigPath({ dbPath, env = process.env } = {}) {
	return readEnv("POLICY_CONFIG", { env }) ?? join(dirname(dbPath), POLICY_FILE);
}

export function emptyPolicyFile() {
	return { schemaVersion: POLICY_SCHEMA_VERSION, default: null, projects: {}, workspaces: {} };
}

// Файл читается на каждом обращении: на одной машине могут жить несколько
// серверов (по агенту на worktree), и все должны видеть одну политику.
export function readPolicyFile({ dbPath, env = process.env, log = console.error } = {}) {
	const path = policyConfigPath({ dbPath, env });
	if (!existsSync(path)) return emptyPolicyFile();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return {
			...emptyPolicyFile(),
			...raw,
			projects: raw.projects ?? {},
			workspaces: raw.workspaces ?? {},
		};
	} catch (err) {
		log(`actari: policy.json не прочитан (${err.message}) — действуют нейтральные правила`);
		return emptyPolicyFile();
	}
}

export function writePolicyFile({ dbPath, env = process.env, file }) {
	const path = policyConfigPath({ dbPath, env });
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`);
	return path;
}

// Одно целое тело, без слияний: облачный проект — только кэш пространства,
// локальный — projects → default → lenient. project — строка таблицы projects.
export function resolvePolicy({ file, project }) {
	const warnings = [];
	if (project.cloud_workspace_id) {
		const entry = file.workspaces[project.cloud_workspace_id];
		if (entry?.body) {
			return {
				source: `workspace:${entry.slug ?? project.cloud_workspace_id}`,
				policy: entry.body,
				warnings,
			};
		}
		warnings.push(
			`политика пространства для проекта "${project.name}" не загружена — действуют нейтральные правила (проверь connect / sync)`,
		);
		return { source: "lenient", policy: LENIENT_POLICY, warnings };
	}
	const own = file.projects[project.name];
	if (own) return { source: "project", policy: own, warnings };
	if (file.default) return { source: "default", policy: file.default, warnings };
	return { source: "lenient", policy: LENIENT_POLICY, warnings };
}

// Описания инструментов рендерятся один раз на сессию, а сервер один на все
// проекты машины: default → единственное пространство → lenient.
export function pickStartupPolicy(file) {
	if (file.default) return file.default;
	const cached = Object.values(file.workspaces ?? {}).filter((w) => w?.body);
	if (cached.length === 1) return cached[0].body;
	return LENIENT_POLICY;
}

export function renderArtifactTitle(template, projectName) {
	return template.replaceAll("{project}", projectName);
}

// Правило видно в момент вызова инструмента — помнить старт сессии не нужно.
export function renderToolDescription(base, policy, act) {
	const text = (policy.guidance?.[act] ?? "").trim();
	if (!text) return base;
	return `${base}\n\nПравила политики «${policy.name}»:\n${text}`;
}

// Ответ облака — ВСЕ пространства пользователя, поэтому секция заменяется
// целиком: пространство без политики или с невалидным телом выпадает из кэша.
export function applyWorkspacePolicies(file, workspaces, now = new Date().toISOString()) {
	const next = {};
	for (const ws of workspaces) {
		if (!ws?.id || !ws.policyId || !ws.body) continue;
		if (validatePolicyBody(ws.body).length > 0) continue;
		next[ws.id] = {
			id: ws.id,
			slug: ws.slug ?? null,
			policyId: ws.policyId,
			version: ws.version ?? null,
			fetchedAt: now,
			body: normalizePolicyBody(ws.body),
		};
	}
	return { ...file, workspaces: next };
}

// GET политик пространств — тот же личный токен, что у инбокса.
export async function fetchWorkspacePolicies({ config, policyUrl }) {
	if (!config?.url || !config?.token) {
		return { error: "конфиг синка неполный: нужны url и token" };
	}
	try {
		const res = await fetch(policyUrl, {
			headers: {
				authorization: `Bearer ${config.token}`,
				"cache-control": "no-store",
				pragma: "no-cache",
			},
		});
		if (!res.ok) return { error: `GET политики: HTTP ${res.status}` };
		const body = await res.json();
		if (!Array.isArray(body?.workspaces)) {
			return { error: "GET политики: облако не вернуло workspaces" };
		}
		return { workspaces: body.workspaces };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
