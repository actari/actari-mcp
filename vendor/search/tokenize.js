import { normalize } from "./normalize.js";
// Последовательности букв/цифр; части идентификаторов соединяются `_`, `-`, `.` только между буквенно-цифровыми кусками.
const WORD_RE = /[\p{L}\p{N}]+(?:[_.-][\p{L}\p{N}]+)*/gu;
const SEPARATOR_RE = /[_.-]/;
// camelCase: нижняя→верхняя («autoValidation») и конец аббревиатуры («HTTPServer» → HTTP, Server).
const CAMEL_RE = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;
/**
 * Токены текста. Идентификаторы (camelCase, snake_case, `a-b`, `a.b`) дают целый токен (части склеены)
 * и части: `InspectionAutoValidation` → `inspectionautovalidation`, `inspection`, `auto`, `validation`.
 */
export function tokenize(text) {
    const out = [];
    for (const match of text.normalize("NFKC").matchAll(WORD_RE)) {
        const pieces = [];
        for (const part of match[0].split(SEPARATOR_RE)) {
            pieces.push(...part.split(CAMEL_RE));
        }
        if (pieces.length > 1)
            out.push(normalize(pieces.join("")));
        for (const piece of pieces)
            out.push(normalize(piece));
    }
    return out;
}
//# sourceMappingURL=tokenize.js.map