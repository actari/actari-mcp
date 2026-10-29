import { analyze } from "./analyze.js";
const WORD_RE = /[\p{L}\p{N}]+/gu;
// Абсолютный локальный путь: /Users/…, /home/… или C:\… до пробела, кавычки или скобки.
const LOCAL_PATH_RE = /(?<![\w.:/-])(?:\/(?:Users|home)\/|\b[A-Za-z]:\\)[^\s`"'<>()[\]{}]*/g;
/**
 * Убирает из текста абсолютные локальные пути (`/Users/<имя>/…`, `/home/…`, `C:\…`): на выводе они
 * раскрывают имя пользователя и структуру его машины. Остаётся `~/последний_сегмент`, конечная
 * пунктуация предложения сохраняется. Текст фрагментов в индексе не меняется (версия анализатора та же).
 */
export function scrubLocalPaths(text) {
    return text.replace(LOCAL_PATH_RE, (path) => {
        const trailing = /[.,;:!?]+$/.exec(path)?.[0] ?? "";
        const body = trailing ? path.slice(0, -trailing.length) : path;
        const last = body.split(/[\\/]/).filter(Boolean).pop() ?? "";
        return `~/${last}${trailing}`;
    });
}
/**
 * Окно вокруг первого слова, основа которого есть в `queryStems`; нет совпадения — начало текста.
 * Пробелы схлопываются; длина содержимого ≤ `len`, к ней добавляются «…» с обрезанных сторон.
 */
export function snippet(text, queryStems, len = 280) {
    const flat = scrubLocalPaths(text).replace(/\s+/g, " ").trim();
    if (flat.length <= len)
        return flat;
    const stems = new Set(queryStems);
    let hit = -1;
    if (stems.size > 0) {
        for (const m of flat.matchAll(WORD_RE)) {
            if (analyze(m[0]).some((s) => stems.has(s))) {
                hit = m.index ?? 0;
                break;
            }
        }
    }
    if (hit < 0)
        return `${flat.slice(0, len).trimEnd()}…`;
    let start = Math.max(0, hit - Math.floor(len / 4));
    if (start > 0) {
        const space = flat.indexOf(" ", start);
        if (space >= 0 && space < hit)
            start = space + 1;
    }
    let end = Math.min(flat.length, start + len);
    if (end < flat.length) {
        const space = flat.lastIndexOf(" ", end);
        if (space > hit)
            end = space;
    }
    return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}
//# sourceMappingURL=snippet.js.map