import { isStopword } from "./stopwords.js";
import { stemEn, stemRu } from "./snowball/index.js";
import { tokenize } from "./tokenize.js";
/** Меняется при любой смене анализа: по ней локальный индекс понимает, что его пора перестроить. */
export const ANALYZER_VERSION = "1";
const CYRILLIC = /[а-я]/;
const LATIN = /[a-z]/;
function stem(token) {
    const cyr = CYRILLIC.test(token);
    const lat = LATIN.test(token);
    if (cyr && !lat)
        return stemRu(token);
    if (lat && !cyr && /^[a-z]+$/.test(token))
        return stemEn(token);
    return token;
}
/** Основы слов текста без стоп-слов, с повторами. */
export function analyze(text) {
    const out = [];
    for (const token of tokenize(text)) {
        if (isStopword(token))
            continue;
        out.push(stem(token));
    }
    return out;
}
/** Уникальные основы запроса (для OR-выражения), в порядке появления. */
export function analyzeQuery(q) {
    return [...new Set(analyze(q))];
}
//# sourceMappingURL=analyze.js.map