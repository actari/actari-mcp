/** Нормализация текста: нижний регистр, ё→е, NFKC. */
export function normalize(text) {
    return text.normalize("NFKC").toLowerCase().replaceAll("ё", "е");
}
//# sourceMappingURL=normalize.js.map