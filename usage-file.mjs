// Разбор файлов запуска для log_usage { usage_file }: сервер журнала сам
// считает токены, агент числа не переписывает (спека ai-token-usage §1.2).
// Форматы определяются по содержимому:
//   claude-transcript — JSONL транскрипта Claude Code (субагент, форк скилла):
//     строки type:"assistant" с message.usage; один ответ пишется несколькими
//     строками с одним message.id — берём последнюю строку группы;
//   claude-json — результат `claude -p --output-format json`: объект type:"result";
//   opencode-json — поток `opencode run --format json`: части type:"step-finish";
//   codex-json — поток `codex exec --json`: события turn.completed с usage по ходам.
// parseUsageFile бросает Error с причиной по-русски — скилл тогда пишет
// строку «токены: клиент не отдал».

import { readFileSync } from "node:fs";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Неотрицательное целое из поля usage; всё остальное — 0.
function count(value) {
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function emptyTotals() {
	return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

function addClaudeUsage(totals, usage) {
	totals.input_tokens += count(usage.input_tokens);
	totals.output_tokens += count(usage.output_tokens);
	totals.cache_read_tokens += count(usage.cache_read_input_tokens);
	totals.cache_write_tokens += count(usage.cache_creation_input_tokens);
}

function roundCost(value) {
	return Math.round(value * 1e6) / 1e6;
}

function parseTranscript(rows) {
	// Map сохраняет порядок первой вставки; повторная вставка того же id
	// перезаписывает значение — остаётся последняя строка группы.
	const byId = new Map();
	let anonymous = 0;
	for (const row of rows) {
		if (row?.type !== "assistant" || !isObject(row.message) || !isObject(row.message.usage))
			continue;
		const id =
			typeof row.message.id === "string" && row.message.id ? row.message.id : `#${anonymous++}`;
		byId.set(id, row.message);
	}
	if (byId.size === 0) return null;
	const totals = emptyTotals();
	const models = [];
	for (const message of byId.values()) {
		addClaudeUsage(totals, message.usage);
		if (typeof message.model === "string" && message.model && !models.includes(message.model)) {
			models.push(message.model);
		}
	}
	return { format: "claude-transcript", models, ...totals };
}

function parseClaudeResult(rows) {
	const result = rows.find((row) => row?.type === "result" && isObject(row.usage));
	if (!result) return null;
	const totals = emptyTotals();
	addClaudeUsage(totals, result.usage);
	const models = isObject(result.modelUsage) ? Object.keys(result.modelUsage) : [];
	const parsed = { format: "claude-json", models, ...totals };
	if (typeof result.total_cost_usd === "number" && result.total_cost_usd >= 0) {
		parsed.cost_usd = roundCost(result.total_cost_usd);
	}
	return parsed;
}

// step-finish может лежать на верхнем уровне события или в его поле part.
function stepFinishOf(row) {
	if (!isObject(row)) return null;
	if (row.type === "step-finish" && isObject(row.tokens)) return row;
	if (isObject(row.part) && row.part.type === "step-finish" && isObject(row.part.tokens)) {
		return row.part;
	}
	return null;
}

function parseOpencode(rows) {
	const steps = rows.map(stepFinishOf).filter(Boolean);
	if (steps.length === 0) return null;
	const totals = emptyTotals();
	let cost = 0;
	let hasCost = false;
	const models = [];
	for (const step of steps) {
		const tokens = step.tokens;
		totals.input_tokens += count(tokens.input);
		// reasoning-токены тарифицируются как выход
		totals.output_tokens += count(tokens.output) + count(tokens.reasoning);
		totals.cache_read_tokens += count(tokens.cache?.read);
		totals.cache_write_tokens += count(tokens.cache?.write);
		if (typeof step.cost === "number" && step.cost >= 0) {
			cost += step.cost;
			hasCost = true;
		}
		const model = step.modelID ?? step.model;
		if (typeof model === "string" && model && !models.includes(model)) models.push(model);
	}
	const parsed = { format: "opencode-json", models, ...totals };
	if (hasCost) parsed.cost_usd = roundCost(cost);
	return parsed;
}

// Отображение usage Codex (семантика OpenAI): cached входит в input, reasoning —
// в output. Общее для rollout-файла сессии и для потока `codex exec --json`.
export function codexFields(usage) {
	const input = count(usage.input_tokens);
	const cached = count(usage.cached_input_tokens);
	return {
		input_tokens: Math.max(0, input - cached),
		output_tokens: count(usage.output_tokens),
		cache_read_tokens: cached,
		cache_write_tokens: count(usage.cache_write_input_tokens),
	};
}

function parseCodexExec(rows) {
	const turns = rows.filter((row) => row?.type === "turn.completed" && isObject(row.usage));
	if (turns.length === 0) return null;
	const totals = emptyTotals();
	for (const turn of turns) {
		const f = codexFields(turn.usage);
		totals.input_tokens += f.input_tokens;
		totals.output_tokens += f.output_tokens;
		totals.cache_read_tokens += f.cache_read_tokens;
		totals.cache_write_tokens += f.cache_write_tokens;
	}
	return { format: "codex-json", models: [], ...totals };
}

function parseRows(text) {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("файл пуст");
	// Целиком одним JSON-документом: объект result или массив событий.
	try {
		const whole = JSON.parse(trimmed);
		if (Array.isArray(whole)) return whole;
		if (isObject(whole)) return [whole];
	} catch {
		// не один документ — читаем построчно (JSONL)
	}
	const rows = [];
	for (const line of trimmed.split("\n")) {
		const piece = line.trim();
		if (!piece) continue;
		try {
			rows.push(JSON.parse(piece));
		} catch {
			// посторонняя строка (лог, прогресс) — пропускаем
		}
	}
	if (rows.length === 0) throw new Error("в файле нет ни одной строки JSON");
	return rows;
}

export function parseUsageFile(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`не удалось прочитать файл ${path}: ${err.code ?? err.message}`);
	}
	const rows = parseRows(text);
	const parsed =
		parseTranscript(rows) ?? parseClaudeResult(rows) ?? parseOpencode(rows) ?? parseCodexExec(rows);
	if (!parsed) {
		throw new Error(
			"формат не распознан: нужен транскрипт Claude Code (JSONL), вывод `claude -p --output-format json`, `opencode run --format json` или `codex exec --json`",
		);
	}
	const { models, ...rest } = parsed;
	const total =
		rest.input_tokens + rest.output_tokens + rest.cache_read_tokens + rest.cache_write_tokens;
	if (total === 0) throw new Error("в файле нулевой расход токенов");
	return models.length > 0 ? { ...rest, model: models.join(", ") } : rest;
}
