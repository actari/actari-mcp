// Стенд «старого процесса журнала»: держит соединение и подготовленный INSERT
// с момента открытия (как живая сессия до обновления схемы). Команды — строками в stdin:
//   write <task_id> — вставить событие TaskDrafted; ответ «ok» или «err <текст>»
//   quit — выйти
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { statSync } from "node:fs";

const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const insert = db.prepare("INSERT INTO events(task_id, type, payload) VALUES (?, ?, ?)");
const st = statSync(dbPath);
console.log(`ready ${st.dev}:${st.ino}`);

createInterface({ input: process.stdin }).on("line", (line) => {
	const [cmd, arg] = line.trim().split(" ");
	if (cmd === "quit") {
		db.close();
		process.exit(0);
	}
	if (cmd === "write") {
		try {
			insert.run(
				arg,
				"TaskDrafted",
				JSON.stringify({ project: "old", title: "от старого процесса", task_text: "x" }),
			);
			console.log("ok");
		} catch (err) {
			console.log(`err ${err.message}`);
		}
	}
});
