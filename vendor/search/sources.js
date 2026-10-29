/** Правила источников: что индексируется, ключи документов, версии артефактов. */
export const SERVICE_NOTE_PREFIXES = [
    "acceptance:",
    "release:",
    "released:",
    "brief:",
    "progress:",
];
const INDEXED_KINDS = new Set([
    "doc",
    "spec",
    "plan",
    "adr",
    "decision",
    "note",
]);
/**
 * Артефакт индексируется, если его вид — doc/spec/plan/adr/decision/note и это не служебная заметка
 * (заметка с заголовком на acceptance:, release:, released:, brief:, progress:). `Project baseline` индексируется.
 */
export function shouldIndexArtifact(a) {
    if (!INDEXED_KINDS.has(a.kind))
        return false;
    if (a.kind === "note") {
        const title = a.title.trimStart().toLowerCase();
        if (SERVICE_NOTE_PREFIXES.some((p) => title.startsWith(p)))
            return false;
    }
    return true;
}
export function artifactDocKey(project, title) {
    return `artifact:${project}:${title}`;
}
export function journalTaskDocKey(taskId) {
    return `task:${taskId}`;
}
export function incidentDocKey(id) {
    return `incident:${id}`;
}
export function entityDocKey(entityType, id) {
    return `${entityType}:${id}`;
}
/** Множитель счёта для совпадения только в устаревшей версии артефакта. */
export const OLD_VERSION_PENALTY = 0.7;
/**
 * Один документ — одна запись. Счёт — лучший среди фрагментов всех версий документа; показывается свежайшая
 * версия, в которой нашлось совпадение. Если это не последняя версия документа — счёт умножается на
 * `OLD_VERSION_PENALTY`. Порядок результата — по убыванию счёта (стабильный).
 */
export function collapseByDoc(hits) {
    const groups = new Map();
    for (const h of hits) {
        const list = groups.get(h.docKey);
        if (list)
            list.push(h);
        else
            groups.set(h.docKey, [h]);
    }
    const out = [];
    for (const list of groups.values()) {
        let rep = list[0];
        let best = list[0].score;
        for (const h of list) {
            if (h.score > best)
                best = h.score;
            const hv = h.version ?? -1;
            const rv = rep.version ?? -1;
            if (hv > rv || (hv === rv && h.score > rep.score))
                rep = h;
        }
        out.push({ ...rep, score: rep.isLatest ? best : best * OLD_VERSION_PENALTY });
    }
    return out
        .map((h, i) => ({ h, i }))
        .sort((a, b) => b.h.score - a.h.score || a.i - b.i)
        .map(({ h }) => h);
}
export function versionLabel(sourceAt) {
    return `версия от ${sourceAt.toISOString().slice(0, 10)}`;
}
//# sourceMappingURL=sources.js.map