/** Период из вопроса («за последний месяц», «в сентябре», «с 1 октября»); границы — UTC, `to` включительно. */
const DAY = 86400000;
// Формы месяца: именительный, родительный, предложный.
const MONTHS = [
    ["январь", "января", "январе"],
    ["февраль", "февраля", "феврале"],
    ["март", "марта", "марте"],
    ["апрель", "апреля", "апреле"],
    ["май", "мая", "мае"],
    ["июнь", "июня", "июне"],
    ["июль", "июля", "июле"],
    ["август", "августа", "августе"],
    ["сентябрь", "сентября", "сентябре"],
    ["октябрь", "октября", "октябре"],
    ["ноябрь", "ноября", "ноябре"],
    ["декабрь", "декабря", "декабре"],
];
function monthIndex(word, forms) {
    return MONTHS.findIndex((m) => forms.some((f) => m[f] === word));
}
const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const endOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 1) - 1);
/** Ближайшая уже наступившая дата (день, месяц): в этом году, иначе в прошлом. */
function recentDate(day, month, now) {
    let d = new Date(Date.UTC(now.getUTCFullYear(), month, day));
    if (d.getTime() > now.getTime())
        d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
    return d;
}
export function parsePeriod(question, now) {
    const q = question.toLowerCase().replaceAll("ё", "е");
    // «за последние N дней / недель / месяцев»
    const rel = /за\s+последни[ехй]\s+(\d+)\s+(дн|день|дня|дней|недел|месяц)/.exec(q);
    if (rel) {
        const n = Number(rel[1]);
        const unit = rel[2].startsWith("недел") ? 7 : rel[2].startsWith("месяц") ? 30 : 1;
        return { from: new Date(now.getTime() - n * unit * DAY), to: now };
    }
    if (/за\s+(?:последн\S+\s+)?месяц/.test(q))
        return { from: new Date(now.getTime() - 30 * DAY), to: now };
    if (/за\s+(?:последн\S+\s+)?недел/.test(q))
        return { from: new Date(now.getTime() - 7 * DAY), to: now };
    if (/(?<![а-я])сегодня(?![а-я])/.test(q))
        return { from: startOfDay(now), to: now };
    if (/(?<![а-я])вчера(?![а-я])/.test(q)) {
        const today = startOfDay(now);
        return { from: new Date(today.getTime() - DAY), to: new Date(today.getTime() - 1) };
    }
    if (/(?<![а-я])в\s+этом\s+месяце(?![а-я])/.test(q)) {
        return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
    }
    if (/(?<![а-я])в\s+прошлом\s+месяце(?![а-я])/.test(q)) {
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth() - 1;
        return { from: new Date(Date.UTC(y, m, 1)), to: endOfMonth(y, m) };
    }
    // «с 2026-10-20»
    const iso = /(?<![а-я])с\s+(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(q);
    if (iso)
        return {
            from: new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))),
            to: now,
        };
    // «с 1 октября»
    const since = /(?<![а-я])с\s+(\d{1,2})\s+([а-я]+)/.exec(q);
    if (since) {
        const m = monthIndex(since[2], [1]);
        if (m >= 0)
            return { from: recentDate(Number(since[1]), m, now), to: now };
    }
    // «в сентябре», «за сентябрь», «в феврале 2024»
    const inMonth = /(?<![а-я])(?:в|за)\s+([а-я]+)(?:\s+(\d{4}))?/g;
    for (const match of q.matchAll(inMonth)) {
        const m = monthIndex(match[1], match[0].startsWith("в") ? [2] : [0]);
        if (m < 0)
            continue;
        let year = match[2] ? Number(match[2]) : now.getUTCFullYear();
        if (!match[2] && Date.UTC(year, m, 1) > now.getTime())
            year -= 1;
        return { from: new Date(Date.UTC(year, m, 1)), to: endOfMonth(year, m) };
    }
    return null;
}
export function inPeriod(at, p) {
    if (!at)
        return false;
    const t = at.getTime();
    return t >= p.from.getTime() && t <= p.to.getTime();
}
//# sourceMappingURL=period.js.map