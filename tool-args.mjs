// Проверка аргументов tools/call по inputSchema: только required и базовые type.
// Строгая JSON Schema (enum, pattern, вложенные схемы) сознательно вне объёма.
const TYPE_CHECKS = {
	string: (v) => typeof v === "string",
	number: (v) => typeof v === "number" && Number.isFinite(v),
	boolean: (v) => typeof v === "boolean",
	array: (v) => Array.isArray(v),
	object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

export function checkToolArguments(inputSchema, args) {
	const properties = inputSchema?.properties ?? {};
	const required = inputSchema?.required ?? [];
	const missing = required.filter((name) => args[name] === undefined || args[name] === null);
	const wrongType = [];
	const unknown = [];
	for (const [name, value] of Object.entries(args)) {
		const prop = properties[name];
		if (!prop) {
			unknown.push(name);
			continue;
		}
		if (value === undefined || value === null) continue;
		const check = TYPE_CHECKS[prop.type];
		if (check && !check(value)) wrongType.push({ name, expected: prop.type });
	}
	return { missing, wrongType, unknown };
}

function allowedList(inputSchema) {
	const required = new Set(inputSchema?.required ?? []);
	return (
		Object.keys(inputSchema?.properties ?? {})
			.map((n) => (required.has(n) ? `${n} (обязательное)` : n))
			.join(", ") || "—"
	);
}

export function formatToolArgumentsError(toolName, inputSchema, { missing, wrongType, unknown }) {
	const lines = [`Неверные аргументы ${toolName}, ничего не записано.`];
	if (missing.length) lines.push(`Нет обязательных полей: ${missing.join(", ")}.`);
	if (wrongType.length)
		lines.push(
			`Неверный тип: ${wrongType.map((w) => `${w.name} (ожидается ${w.expected})`).join(", ")}.`,
		);
	if (unknown.length) lines.push(`Неизвестные поля: ${unknown.join(", ")}.`);
	lines.push(`Допустимые поля: ${allowedList(inputSchema)}.`);
	return lines.join("\n");
}

export function formatUnknownHint(inputSchema, unknown) {
	return `Подсказка: неизвестные поля проигнорированы: ${unknown.join(", ")}. Допустимые: ${allowedList(inputSchema)}.`;
}
