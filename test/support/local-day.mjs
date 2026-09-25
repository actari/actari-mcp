// Локальный день — так же, как today() в server.mjs: слаги задач живут в локальном дне.
export function localDay(d = new Date()) {
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}
