/** Слияние списков: Reciprocal Rank Fusion с весами по списку; перебор косинуса для небольших объёмов. */
export const RRF_K = 60;
/**
 * Веса по умолчанию, выбраны по полному контрольному набору (48 + реальные + точные термины) на обоих
 * хранилищах: сетка vector 1–4 × words 0/0.5/1, максимум минимального запаса над порогами брифа §6.
 * Векторы — главный сигнал (×8 к словам); слова — добавка для точных терминов. Только векторы (words 0)
 * дают лучший MRR на 48 вопросах, но на полном наборе облачный hit@5 падает ниже 0.9 (0.896): точные
 * термины слова добавляют. Таблица сетки — в отчёте задачи search-engine-6 и в выводе тестов порогов.
 */
export const DEFAULT_FUSION_WEIGHTS = {
    vector: 4,
    words: 0.5,
};
export function fuse(lists, opts) {
    const k = opts.k ?? RRF_K;
    const weights = opts.weights ?? DEFAULT_FUSION_WEIGHTS;
    const acc = new Map();
    let order = 0;
    for (const list of lists) {
        const weight = weights[list.name] ?? 0;
        const seen = new Set();
        let rank = 0;
        for (const item of list.items) {
            const id = opts.key(item);
            if (seen.has(id))
                continue;
            seen.add(id);
            rank++;
            const entry = acc.get(id);
            const add = weight / (k + rank);
            if (entry)
                entry.score += add;
            else
                acc.set(id, { item, score: add, order: order++ });
        }
    }
    return [...acc.values()]
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map(({ item, score }) => ({ item, score }));
}
export function cosineTopK(query, rows, k) {
    let qn = 0;
    for (let i = 0; i < query.length; i++)
        qn += query[i] * query[i];
    qn = Math.sqrt(qn) || 1;
    const scored = rows.map((row) => {
        let dot = 0;
        let vn = 0;
        const n = Math.min(query.length, row.vec.length);
        for (let i = 0; i < n; i++) {
            dot += query[i] * row.vec[i];
            vn += row.vec[i] * row.vec[i];
        }
        return { id: row.id, score: dot / (qn * (Math.sqrt(vn) || 1)) };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
//# sourceMappingURL=fuse.js.map