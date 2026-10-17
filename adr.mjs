// Формат ADR в журнале: разделы markdown «Контекст / Решение / Последствия / Альтернативы».
// Тот же словарь разбирает облако (packages/core, journal-adr.ts) — менять вместе.

const SECTION_BY_HEADING = new Map([
	["контекст", "context"],
	["context", "context"],
	["решение", "decision"],
	["decision", "decision"],
	["последствия", "consequences"],
	["consequences", "consequences"],
	["альтернативы", "alternatives"],
	["alternatives", "alternatives"],
	["рассмотренные альтернативы", "alternatives"],
	["considered options", "alternatives"],
]);

// Заголовок `#`–`####`, в конце допускается двоеточие.
const HEADING = /^#{1,4}\s+(.+?)\s*:?\s*$/;

/**
 * Разбирает тело ADR на разделы. Текст до первого распознанного заголовка
 * отбрасывается, нераспознанные заголовки остаются внутри текущего раздела,
 * повтор раздела — побеждает первый, пустой раздел — null.
 */
export function parseAdrSections(body) {
	const sections = { context: null, decision: null, consequences: null, alternatives: null };
	const seen = new Set();
	let current = null; // имя раздела, в который идёт текст; null — до первого заголовка или в повторе
	let lines = [];
	const flush = () => {
		if (current) {
			const text = lines.join("\n").trim();
			sections[current] = text === "" ? null : text;
		}
		lines = [];
	};
	for (const line of String(body ?? "").split(/\r?\n/)) {
		const m = HEADING.exec(line);
		const name = m ? SECTION_BY_HEADING.get(m[1].trim().toLowerCase()) : undefined;
		if (name) {
			flush();
			if (seen.has(name)) {
				current = null;
			} else {
				seen.add(name);
				current = name;
			}
			continue;
		}
		if (current) lines.push(line);
	}
	flush();
	return sections;
}

export const ADR_FORMAT_HINT = `ADR не записан: нужны разделы «Контекст» и «Решение» (заголовки markdown; «Последствия» и «Альтернативы» — по желанию). Пример:

## Контекст
Что за задача и какие силы действуют: ограничения, требования, что уже есть.

## Решение
Что выбрано, одним-двумя предложениями.

## Последствия
Что получаем и чем платим.

## Альтернативы
Что рассматривали и почему отказались.`;
