/** Префиксы e5: `passage: ` для фрагментов, `query: ` для вопросов — только для моделей e5. */
export function isE5Model(model) {
    return model.toLowerCase().includes("e5");
}
export function passageText(model, text) {
    return isE5Model(model) ? `passage: ${text}` : text;
}
export function queryText(model, q) {
    return isE5Model(model) ? `query: ${q}` : q;
}
/** Ключ совместимости векторов в строке индекса: по нему переиндексация находит несовместимые векторы. */
export function embeddingKey(model) {
    return `${model}|${isE5Model(model) ? "e5p1" : "plain"}`;
}
//# sourceMappingURL=e5.js.map