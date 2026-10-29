/**
 * Нарезка документов на фрагменты для индекса (слова и векторы).
 * Лимит — подсчёт символов, без токенизатора: 1000 символов текста + заголовок ≤ 150
 * (~1150 символов русского ≈ 300–400 токенов XLM-R, запас до 512).
 */
export const CHUNK_MAX_CHARS = 1000;
export const CHUNK_TITLE_MAX_CHARS = 150;
const HEADING_RE = /^#{1,4}\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const CONTINUATION_HEADING_MAX = 120;
/** Обрезает заголовок документа до лимита по границе слова. */
function clipTitle(title, max) {
    const t = title.replace(/\s+/g, " ").trim();
    if (t.length <= max)
        return t;
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return (space >= Math.floor(max / 2) ? cut.slice(0, space) : cut).trimEnd();
}
function splitSections(body) {
    const sections = [];
    let current = { heading: null, headingLine: null, body: "" };
    let inFence = false;
    for (const line of body.split(/\r?\n/)) {
        if (FENCE_RE.test(line))
            inFence = !inFence;
        const match = inFence ? null : HEADING_RE.exec(line);
        if (match) {
            sections.push(current);
            current = { heading: match[1].trim(), headingLine: line.trim(), body: "" };
        }
        else {
            current.body += `${line}\n`;
        }
    }
    sections.push(current);
    return sections;
}
/** Делит текст на куски вместе с хвостовыми разделителями (без потери символов). */
function splitKeep(text, re) {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
        const end = (m.index ?? 0) + m[0].length;
        parts.push(text.slice(last, end));
        last = end;
    }
    if (last < text.length)
        parts.push(text.slice(last));
    return parts.filter((p) => p.length > 0);
}
const PARAGRAPH_SPLIT = /\n{2,}/g;
const SENTENCE_SPLIT = /(?<=[.!?…])\s+|\n/g;
const WORD_SPLIT = /\s+/g;
/** Жадно упаковывает куски в строки ≤ max; кусок длиннее max уходит на следующий уровень деления. */
function pack(pieces, max, levels) {
    const out = [];
    let buf = "";
    const flush = () => {
        const t = buf.trim();
        if (t)
            out.push(t);
        buf = "";
    };
    for (const piece of pieces) {
        if (piece.trim().length > max) {
            flush();
            const [next, ...rest] = levels;
            if (next)
                out.push(...pack(splitKeep(piece, next), max, rest));
            else {
                for (let i = 0; i < piece.length; i += max) {
                    const part = piece.slice(i, i + max).trim();
                    if (part)
                        out.push(part);
                }
            }
            continue;
        }
        if ((buf + piece).trim().length > max)
            flush();
        buf += piece;
    }
    flush();
    return out;
}
export function chunkDocument(doc, opts = {}) {
    const max = opts.maxChars ?? CHUNK_MAX_CHARS;
    const title = clipTitle(doc.title ?? "", opts.maxTitleChars ?? CHUNK_TITLE_MAX_CHARS);
    const chunks = [];
    for (const section of splitSections(doc.body ?? "")) {
        const body = section.body.trim();
        if (!body)
            continue;
        const head = section.headingLine;
        const first = head ? `${head}\n${body}` : body;
        let texts;
        if (first.length <= max) {
            texts = [first];
        }
        else {
            const prefix = head ? `${head.slice(0, CONTINUATION_HEADING_MAX)}\n` : "";
            const room = Math.max(1, max - prefix.length);
            texts = pack(splitKeep(body, PARAGRAPH_SPLIT), room, [SENTENCE_SPLIT, WORD_SPLIT]).map((t) => `${prefix}${t}`);
        }
        for (const text of texts)
            chunks.push({ index: chunks.length, title, heading: section.heading, text });
    }
    if (chunks.length === 0 && title) {
        chunks.push({ index: 0, title, heading: null, text: "" });
    }
    return chunks;
}
/** Совместимость со старой сигнатурой: тексты фрагментов без заголовка документа. */
export function chunkText(content) {
    return chunkDocument({ title: "", body: content }).map((c) => c.text);
}
/** Текст для эмбеддинга (без префикса e5): заголовок и фрагмент. */
export function chunkEmbeddingText(c) {
    return `${c.title}\n${c.text}`;
}
//# sourceMappingURL=chunk.js.map